import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const orderId = 'a'.repeat(64);
const offer = { id: 'standard', title: 'Standard credits', mode: 'payment', money: { amount: '29.00', currency: 'USD' },
  credits: 100, expiresInDays: 30, providers: [
    { id: 'stripe', requiresCapture: false, referralProviders: ['affonso'] },
    { id: 'paypal', requiresCapture: true, referralProviders: [] },
  ] };
const order = { id: orderId, offerId: offer.id, providerId: 'stripe', title: offer.title, mode: 'payment', money: offer.money,
  state: 'pending', creationState: 'created', captureState: 'idle', checkoutUrl: null,
  fulfilledAt: null, createdAt: '2026-10-24T01:00:00.000Z', subscriptionId: null };
const paid = { ...order, state: 'paid', fulfilledAt: '2026-10-24T01:01:00.000Z' };
const envelope = (route: Route, result: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({
  status, contentType: 'application/json', headers, body: JSON.stringify({ status, message: status === 200 ? 'success' : 'Synthetic request failure', result }),
});
const externalRequests = new WeakMap<BrowserContext, string[]>();

for (const scenario of [
  { locale: 'en', state: 'full', status: 'Refunded', amount: '29.00', label: 'Confirmed refunded amount', attention: false },
  { locale: 'zh', state: 'partial', status: '部分退款', amount: '10.00', label: '已确认退款金额', attention: true },
  { locale: 'en', state: 'pending', status: 'Refund being checked', amount: '0.00', label: 'Refund amount being checked', attention: false },
]) {
  test(`refund summary keeps ${scenario.state} cash separate from purchase completion (${scenario.locale}, narrow screen)`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await session(context, baseURL);
    const current = { ...paid, refund: { state: scenario.state, refundedMoney: { amount: scenario.amount, currency: 'USD' },
      pendingMoney: scenario.state === 'pending' ? { amount: '10.00', currency: 'USD' } : null,
      suppressedCredits: scenario.state === 'full' ? 100 : 0, recoveredCredits: scenario.state === 'partial' ? 34 : 0, needsAttention: scenario.attention } };
    const mutations: string[] = [];
    await page.route('**/api/billing/refunds**', route => { mutations.push(route.request().method()); return envelope(route, null, 503); });
    await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, current));
    await page.goto(`/${scenario.locale}/billing/return?order=${orderId}`);
    await expect(page.getByText(scenario.status, { exact: true })).toBeVisible();
    await expect(page.getByText(scenario.label, { exact: true })).toBeVisible();
    await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Payment is confirmed and the purchase has been applied to your account.', { exact: true })).toHaveCount(0);
    if (scenario.attention) await expect(page.getByText('退款或相关积分还需要进一步核对。已确认的付款和退款金额会分别保留。', { exact: true })).toBeVisible();
    expect(mutations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await noBillingScripts(page);
  });
}

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== 'localhost') throw new Error('Billing browser checks require a localhost test server');
  const origin = new URL(baseURL).origin;
  const requests: string[] = []; externalRequests.set(context, requests);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      requests.push(route.request().url());
      if (url.hostname === 'cdn.affonso.io') return route.fulfill({ contentType: 'application/javascript', body:
        "window.affonso_referral='synthetic_referral';document.cookie='affonso_referral=synthetic_referral; Path=/; SameSite=Lax';" });
      if (url.hostname === 'pagead2.googlesyndication.com') return route.fulfill({ contentType: 'application/javascript',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: 'window.__syntheticAdSense = true;' });
      if (url.hostname === 'payments.example.test') return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic checkout</h1>' });
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) return envelope(route, null, 503);
    return route.continue();
  });
});

async function session(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error('Missing local baseURL');
  const origin = new URL(baseURL).origin;
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/api/authorize/me', route => envelope(route, { id: 'synthetic-user', username: 'synthetic', permissions: [] }));
  await context.addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'synthetic-token', refreshToken: null,
      isAuthenticated: true, user: { id: 'synthetic-user', username: 'synthetic' }, permissions: [] } }));
  }, { origin });
}
async function noBillingScripts(page: Page) {
  await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
}

test('public catalog has recoverable failure and an honest empty state', async ({ page }) => {
  let fail = true;
  await page.route('**/api/billing/catalog', route => envelope(route, [], fail ? 503 : 200));
  await page.goto('/en/pricing');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Plans could not be loaded. Try again.');
  fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No plans are available yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to checkout' })).toHaveCount(0);
});

test('checkout retries retain one key across reload and send only server selections and supported referral', async ({ page, context, baseURL }) => {
  await session(context, baseURL);
  const attempts: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
  await page.route('**/api/billing/catalog', route => envelope(route, [offer]));
  await page.route('**/api/billing/orders', route => {
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    return attempts.length === 1 ? envelope(route, null, 503) : envelope(route, { ...order, checkoutUrl: 'https://payments.example.test/checkout' });
  });
  await page.goto('/en/pricing');
  await expect(page.getByText('USD 29.00', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain('affonso_referral=synthetic_referral');
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('resume the existing attempt');
  await page.reload();
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic checkout' })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toMatch(/^[a-f0-9]{32}$/);
  expect(attempts[1].key).toBe(attempts[0].key);
  expect(attempts[0].body).toEqual({ offerId: 'standard', providerId: 'stripe', referral: { provider: 'affonso', referralId: 'synthetic_referral' } });
  expect(attempts[1].body).toEqual(attempts[0].body);
});

test('unsupported referral stays out of PayPal purchase and public fallback opens a fresh billing document', async ({ page, context, baseURL }) => {
  await session(context, baseURL); const writes: unknown[] = [];
  await page.route('**/api/billing/catalog', route => envelope(route, [offer]));
  await page.route('**/api/billing/orders', route => { writes.push(route.request().postDataJSON()); return envelope(route, { ...order, providerId: 'paypal' }); });
  await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, { ...order, providerId: 'paypal' }));
  await page.route(`**/api/billing/orders/${orderId}/confirm`, route => envelope(route, { ...order, providerId: 'paypal' }));
  await page.goto('/en/pricing');
  await page.getByLabel('Payment method').selectOption('paypal');
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__publicDocument = true; });
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page).toHaveURL(new RegExp(`/en/billing/return\\?order=${orderId}`));
  await expect(page.getByRole('heading', { name: 'Payment status' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__publicDocument)).toBeUndefined();
  expect(writes).toEqual([{ offerId: 'standard', providerId: 'paypal' }]);
  await noBillingScripts(page);
});

test('an empty client store with a valid refresh cookie retains the server-owned attempt scope after hydration', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('Missing local baseURL');
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  let refreshes = 0; const keys: string[] = [];
  await page.route('**/api/authorize/refresh', route => { refreshes++; return envelope(route, { access_token: 'fresh-billing-token' }); });
  await page.route('**/api/authorize/me', route => route.request().headers().authorization === 'Bearer fresh-billing-token'
    ? envelope(route, { id: 'synthetic-user', username: 'synthetic', permissions: [] }) : envelope(route, null, 401));
  await page.route('**/api/billing/catalog', route => envelope(route, [offer]));
  await page.route('**/api/billing/orders', route => {
    keys.push(route.request().headers()['idempotency-key']);
    return keys.length === 1 ? envelope(route, null, 503) : envelope(route, { ...order, checkoutUrl: 'https://payments.example.test/checkout' });
  });
  await page.goto('/en/pricing'); await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('resume the existing attempt');
  expect(refreshes).toBe(1);
  const storedScopes = await page.evaluate(() => Object.keys(sessionStorage));
  expect(storedScopes.some(key => key.includes('synthetic-user'))).toBe(true);
  expect(storedScopes.some(key => key.includes('anonymous'))).toBe(false);
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}');
    stored.state.user = { id: 'synthetic-user', username: 'synthetic' };
    localStorage.setItem('auth-storage', JSON.stringify(stored));
  });
  await page.reload(); await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic checkout' })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(refreshes).toBe(1);
});

test('return ignores claimed success in URL and only displays completion after server fulfillment', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let completed = false; const methods: string[] = [];
  await page.route(`**/api/billing/orders/${orderId}`, route => { methods.push(route.request().method()); return envelope(route, order); });
  await page.route(`**/api/billing/orders/${orderId}/confirm`, route => { methods.push(route.request().method()); return envelope(route, completed ? paid : order); });
  await page.goto(`/en/billing/return?order=${orderId}&paymentStatus=paid&success=true`);
  await expect(page.getByText('Awaiting payment', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  expect(methods).toContain('GET'); expect(methods).toContain('POST');
  completed = true; await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('purchase has been applied');
  await noBillingScripts(page); expect(externalRequests.get(context)).toEqual([]);
});

test('PayPal capture requires an explicit amount-labelled click and unknown capture is not repeated', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let captures = 0, captured = false, unknown = false;
  const current = () => captured ? { ...paid, providerId: 'paypal', captureState: 'confirmed' }
    : { ...order, providerId: 'paypal', state: 'requires_capture', captureState: unknown ? 'submitting' : 'idle' };
  await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, current()));
  await page.route(`**/api/billing/orders/${orderId}/confirm`, route => envelope(route, current()));
  await page.route(`**/api/billing/orders/${orderId}/capture`, route => {
    captures++; unknown = true; expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ approved: true }); return envelope(route, null, 503);
  });
  await page.goto(`/en/billing/return?order=${orderId}&paymentStatus=paid`);
  const pay = page.getByRole('button', { name: 'Pay USD 29.00 with PayPal' });
  await expect(pay).toBeVisible(); expect(captures).toBe(0);
  await pay.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('result could not be confirmed');
  await expect(pay).toHaveCount(0); expect(captures).toBe(1);
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(page.getByText('Confirming payment', { exact: true })).toBeVisible(); expect(captures).toBe(1);
  captured = true; await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible(); expect(captures).toBe(1);
});

test('missing and foreign orders never produce a payment success or capture action', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let calls = 0;
  await page.route('**/api/billing/**', route => { calls++; return envelope(route, null, 403); });
  await page.goto('/en/billing/return?paymentStatus=paid');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('valid order'); expect(calls).toBe(0);
  await page.goto(`/en/billing/return?order=${orderId}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('signed-in account');
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pay .* with PayPal/ })).toHaveCount(0);
});

test('a rejected capture can be retried only after a fresh check proves no capture claim exists', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let captures = 0;
  const approved = { ...order, providerId: 'paypal', state: 'requires_capture' };
  await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, approved));
  await page.route(`**/api/billing/orders/${orderId}/confirm`, route => envelope(route, approved));
  await page.route(`**/api/billing/orders/${orderId}/capture`, route => {
    captures++; return captures === 1 ? envelope(route, null, 503) : envelope(route, { ...paid, providerId: 'paypal', captureState: 'confirmed' });
  });
  await page.goto(`/en/billing/return?order=${orderId}`);
  const pay = page.getByRole('button', { name: 'Pay USD 29.00 with PayPal' });
  await pay.click(); await expect(page.getByRole('main').getByRole('alert')).toContainText('result could not be confirmed');
  await expect(pay).toHaveCount(0); expect(captures).toBe(1);
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(pay).toBeEnabled(); expect(captures).toBe(1);
  await pay.click(); await expect(page.getByText('Completed', { exact: true })).toBeVisible(); expect(captures).toBe(2);
});

test('owned orders paginate through the URL and remain readable on mobile', async ({ page, context, baseURL }) => {
  await session(context, baseURL); const pages: number[] = [];
  await page.route('**/api/billing/orders?*', route => {
    const page = Number(new URL(route.request().url()).searchParams.get('page')); pages.push(page);
    const data = page === 1 ? Array.from({ length: 20 }, (_, index) => ({ ...paid,
      id: index.toString(16).padStart(64, 'c'), title: index === 0 ? 'First-page purchase' : `Purchase ${index + 1}` }))
      : [{ ...order, id: 'b'.repeat(64), title: 'Second-page purchase' }];
    return envelope(route, { data, total: 21, page, pageSize: 20 });
  });
  await page.goto('/en/billing/orders');
  await expect(page.getByRole('heading', { name: 'First-page purchase' })).toBeVisible();
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(/page=2/); await expect(page.getByRole('heading', { name: 'Second-page purchase' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'First-page purchase' })).toBeVisible();
  expect(pages.filter((value, index) => index === 0 || pages[index - 1] !== value)).toEqual([1, 2, 1]);
  await noBillingScripts(page);
});

test('an empty order list can recover from failure without inventing purchases', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let fail = true;
  await page.route('**/api/billing/orders?*', route => envelope(route, { data: [], page: 1, pageSize: 20, total: 0 }, fail ? 503 : 200));
  await page.goto('/en/billing/orders');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be loaded');
  fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('anonymous billing navigation signs in and returns to the same order without marketing scripts', async ({ page, context }) => {
  let orderReads = 0;
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/login')) return envelope(route, { token: 'synthetic-token' }, 200,
      { 'set-cookie': 'zucker-session=synthetic-session; Path=/; HttpOnly; SameSite=Lax' });
    if (path.endsWith('/me')) return envelope(route, { id: 'synthetic-user', username: 'synthetic', permissions: [] });
    if (path.endsWith('/oauth/providers')) return envelope(route, { providers: [] });
    return envelope(route, null, 404);
  });
  await page.route(`**/api/billing/orders/${orderId}`, route => { orderReads++; return envelope(route, paid); });
  await page.goto(`/en/billing/return?order=${orderId}`);
  await expect(page).toHaveURL(/\/en\/login\?redirect=/); expect(orderReads).toBe(0);
  await page.getByLabel('Username', { exact: true }).fill('synthetic');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/billing/return\\?order=${orderId}`));
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await noBillingScripts(page); expect(externalRequests.get(context)).toEqual([]);
});

test('Chinese pricing and order status retain usable layout and keyboard controls', async ({ page, context, baseURL }) => {
  await session(context, baseURL);
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL!, sameSite: 'Lax' }]);
  await page.route('**/api/billing/catalog', route => envelope(route, [{ ...offer, title: '标准积分套餐' }]));
  await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, { ...paid, title: '标准积分套餐' }));
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: '套餐与积分' })).toBeVisible();
  await page.getByLabel('付款方式').focus(); await expect(page.getByLabel('付款方式')).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('pricing-zh.png'), fullPage: true });
  await page.goto(`/billing/return?order=${orderId}`);
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>(resolve => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '付款状态', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('return-zh.png'), fullPage: true });
});

for (const providerId of ['stripe', 'paypal', 'creem']) {
  test(`provider return hint is selected from the owned ${providerId} order and never proves payment`, async ({ page, context, baseURL }) => {
    await session(context, baseURL); const confirmations: unknown[] = [];
    await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, { ...order, providerId, creationState: 'submitting', state: 'unknown' }));
    await page.route(`**/api/billing/orders/${orderId}/confirm`, route => { confirmations.push(route.request().postDataJSON()); return envelope(route, { ...order, providerId }); });
    await page.goto(`/en/billing/return?order=${orderId}&session_id=cs_synthetic&token=paypal_synthetic&checkout_id=ch_synthetic&success=true&paymentStatus=paid`);
    await expect(page.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    const checkoutId = ({ stripe: 'cs_synthetic', paypal: 'paypal_synthetic', creem: 'ch_synthetic' } as Record<string, string>)[providerId];
    expect(confirmations.length).toBeGreaterThan(0); expect(confirmations.every(value => JSON.stringify(value) === JSON.stringify({ checkoutId }))).toBe(true);
    await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    confirmations.length = 0;
    const unrelated = providerId === 'stripe' ? 'token=unrelated' : 'session_id=unrelated';
    await page.goto(`/en/billing/return?order=${orderId}&${unrelated}&success=true`);
    await expect(page.getByRole('button', { name: 'Check payment status' })).toBeEnabled();
    expect(confirmations.length).toBeGreaterThan(0); expect(confirmations.every(value => JSON.stringify(value) === '{}')).toBe(true);
    await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  });
}

for (const state of ['paid', 'unpaid']) {
  test(`verified ${state} provider return retires the attempt before a new explicit purchase`, async ({ page, context, baseURL }) => {
    await session(context, baseURL); const keys: string[] = []; const nextId = 'b'.repeat(64);
    await page.route('**/api/billing/catalog', route => envelope(route, [offer]));
    await page.route('**/api/billing/orders', route => {
      keys.push(route.request().headers()['idempotency-key']);
      return envelope(route, { ...order, id: keys.length === 1 ? orderId : nextId });
    });
    await page.route(`**/api/billing/orders/${orderId}`, route => envelope(route, order));
    await page.route(`**/api/billing/orders/${orderId}/confirm`, route => envelope(route, state === 'paid' ? paid : { ...order, state: 'unpaid' }));
    await page.route(`**/api/billing/orders/${nextId}`, route => envelope(route, { ...order, id: nextId }));
    await page.route(`**/api/billing/orders/${nextId}/confirm`, route => envelope(route, { ...order, id: nextId }));
    await page.goto('/en/pricing'); await page.getByRole('button', { name: 'Continue to checkout' }).click();
    await expect(page.getByText(state === 'paid' ? 'Completed' : 'Not paid', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'View plans', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to checkout' }).click();
    await expect(page).toHaveURL(new RegExp(`order=${nextId}`));
    expect(keys).toHaveLength(2); expect(keys[0]).toMatch(/^[a-f0-9]{32}$/); expect(keys[1]).not.toBe(keys[0]);
  });
}
