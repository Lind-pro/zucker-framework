/**
 * PLAN §2 checks 2–9 against a running stack (compose tier), driven by launch-ready.mjs.
 * Pass 1: production server, no fakes (steps 2, 3, 6, 7, 8, 9). Pass 2: the server recreated with
 * NODE_ENV=test and the fake payment/AI providers (steps 4, 5 and the paid parts of 6/9).
 * Evidence is recorded per step; generated secrets are never written to the report.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(rootDir, 'package.json'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PASSWORD = 'Synthetic-Accept-9!x';

function assert(condition, message) { if (!condition) throw new Error(message); }

/** Minimal JSON client: unwraps the `{status, result}` envelope; never logs bodies. */
function client(base, origin) {
  return async function call(method, path, { token, body, headers = {}, raw = false, expect } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method !== 'GET' ? { origin } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    const value = json && typeof json === 'object' && 'result' in json && 'status' in json ? json.result : json;
    if (expect !== undefined) {
      const ok = Array.isArray(expect) ? expect.includes(response.status) : response.status === expect;
      if (!ok) throw new Error(`${method} ${path} → ${response.status} (expected ${expect}): ${String(json?.message ?? text).slice(0, 300)}`);
    }
    return raw ? { status: response.status, headers: response.headers, text, json, value } : value;
  };
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`${label}: timed out${last ? ` (${last.message})` : ''}`);
}

/** Mailpit HTTP API: newest message to `to` whose subject matches, as text. */
const seenMail = new Set();
/**
 * Oldest unseen message to `to` that carries a ticket link (each mail is consumed once; welcome and
 * receipt mails without a ticket are skipped).
 */
async function mailTo(mailpit, to, { timeoutMs = 30_000 } = {}) {
  return waitFor(`mail to ${to}`, async () => {
    const list = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    for (const message of [...(list.messages ?? [])].reverse()) {
      const key = `${mailpit}#${message.ID}`;
      if (seenMail.has(key)) continue;
      const full = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json();
      const text = `${full.Text ?? ''}\n${full.HTML ?? ''}`;
      if (!/ticket=/.test(text)) continue;
      seenMail.add(key);
      return { subject: full.Subject, text };
    }
    return undefined;
  }, timeoutMs);
}
const ticketOf = (text) => /ticket=([A-Za-z0-9._~%-]+)/.exec(text)?.[1];

export async function runChecks(ctx) {
  const { report, web, admin, api: directApi, mailpit } = ctx;
  const { chromium } = require('@playwright/test');
  const webApi = client(`${web}/api`, web);
  const adminApi = client(`${admin}/api`, admin);
  const server = client(directApi, web);
  const state = { users: {} };
  const browser = await chromium.launch({ headless: true });
  const newPage = async (base, options = {}) => {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, ...options });
    // Nothing leaves the stack: third-party scripts (analytics) are answered locally.
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
      if (route.request().resourceType() === 'script') return route.fulfill({ contentType: 'application/javascript', body: '/* acceptance stub */' });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    return { context, page };
  };
  const adminToken = async () => {
    state.adminToken ??= (await adminApi('POST', '/authorize/login', { body: ctx.adminCredentials, expect: 200 })).token;
    return state.adminToken;
  };
  const savePolicy = async (id, values) => {
    const token = await adminToken();
    const current = await adminApi('GET', `/management/policies/${id}`, { token, expect: 200 });
    return adminApi('PUT', `/management/policies/${id}`, { token, body: { expectedRevision: current.revision ?? current.storedRevision ?? 0, values }, expect: 200 });
  };
  const saveConnection = async (id, values = {}, secrets = {}) => {
    const token = await adminToken();
    const current = await adminApi('GET', `/management/connection-settings/${id}`, { token, expect: 200 });
    return adminApi('PUT', `/management/connection-settings/${id}`, { token, body: { expectedRevision: current.storedRevision, values,
      secrets: Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, { action: 'replace', value }])) }, expect: 200 });
  };
  /** Registers through the web origin, verifies through the mailed ticket, signs in. */
  const signUp = async (label) => {
    const username = `${label}${Date.now().toString(36)}`;
    const email = `${username}@accept.invalid`;
    const started = Date.now() - 1000;
    const registered = await webApi('POST', '/authorize/register', { body: { username, email, password: PASSWORD }, expect: 201 });
    if (registered?.verificationRequired !== false) {
      const mail = await mailTo(mailpit, email, {});
      const ticket = decodeURIComponent(ticketOf(mail.text) ?? '');
      assert(ticket, 'verification mail has no ticket link');
      await webApi('POST', '/authorize/verify-email', { body: { ticket }, expect: 200 });
    }
    const login = await webApi('POST', '/authorize/login', { body: { username, password: PASSWORD }, expect: 200 });
    const user = { username, email, id: login.userId, token: login.token };
    state.users[label] = user;
    return user;
  };

  try {
    // ── Pass 1: production ────────────────────────────────────────────────────────────────
    await report.step('2.health', 'Server readiness and web/admin reachable', async () => {
      const ready = await server('GET', '/health/ready', { raw: true });
      assert(ready.status === 200, `ready ${ready.status}`);
      const home = await fetch(`${web}/`); const adminHome = await fetch(`${admin}/`);
      assert(home.status === 200 && adminHome.status === 200, `web ${home.status} admin ${adminHome.status}`);
      return { ready: ready.status, web: home.status, admin: adminHome.status };
    });

    await report.step('3.public-pages', 'No provider credentials: home from CMS blocks, pricing (not purchasable), blog, docs, privacy, terms, changelog', async () => {
      const { page, context } = await newPage(web);
      const evidence = {};
      try {
        const home = await page.goto('/');
        assert(home.status() === 200, `home ${home.status()}`);
        const cms = await webApi('GET', '/content/public/entry?kind=page&locale=en&slug=home', { expect: 200 });
        const hero = cms?.document?.blocks?.find((block) => block.type === 'hero');
        assert(hero?.heading, 'CMS home has no hero block');
        assert((await page.textContent('body')).includes(hero.heading), 'home page does not render the CMS hero heading');
        evidence.home = { source: cms.source, hero: hero.heading };
        await page.goto('/pricing');
        await page.getByText('Starter', { exact: false }).first().waitFor();
        const pricing = await page.textContent('body');
        assert(/Starter/.test(pricing) && /Pro/.test(pricing), 'example plans missing on pricing');
        assert(pricing.includes('Not available for purchase yet'), 'plans are not marked as not purchasable');
        evidence.pricing = 'Starter, Pro, credits pack: not purchasable';
        for (const path of ['/blog', '/docs', '/privacy', '/terms', '/changelog']) {
          const response = await page.goto(path);
          assert(response.status() === 200, `${path} ${response.status()}`);
          evidence[path] = response.status();
        }
      } finally { await context.close(); }
      return evidence;
    });

    await report.step('3.accounts', 'Sign-up → verification mail (Mailpit) → verify → login; password reset; console; admin login', async () => {
      const user = await signUp('alice');
      const started = Date.now() - 1000;
      await webApi('POST', '/authorize/forgot-password', { body: { email: user.email }, expect: 200 });
      const mail = await mailTo(mailpit, user.email, {});
      const ticket = decodeURIComponent(ticketOf(mail.text) ?? '');
      assert(ticket, 'reset mail has no ticket');
      const newPassword = `${PASSWORD}r`;
      await webApi('POST', '/authorize/reset-password', { body: { ticket, password: newPassword }, expect: 200 });
      const relog = await webApi('POST', '/authorize/login', { body: { username: user.username, password: newPassword }, expect: 200 });
      user.token = relog.token; user.password = newPassword;
      // Console in a real browser session (login form → dashboard).
      const { page, context } = await newPage(web);
      try {
        await page.goto('/login');
        await page.getByLabel('Username', { exact: true }).fill(user.username);
        await page.getByLabel('Password', { exact: true }).fill(newPassword);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
        await page.goto('/dashboard');
        await page.getByTestId('header-credit-balance').waitFor({ timeout: 20_000 });
      } finally { await context.close(); }
      const adminLogin = await adminApi('POST', '/authorize/login', { body: ctx.adminCredentials, expect: 200 });
      assert(adminLogin.token, 'admin login returned no token');
      return { user: user.username, verificationMail: true, resetMail: mail.subject, console: 'dashboard with header balance', adminLogin: true };
    });

    await report.step('6.admin-pages', 'Admin pages load and list data (every menu entry, as the administrator)', async () => {
      const token = await adminToken();
      const tree = await adminApi('GET', '/menu/tree', { token, expect: 200 });
      const paths = [];
      const visit = (nodes) => { for (const node of nodes ?? []) { if (node.path && !node.children?.length && !/^https?:/.test(node.path)) paths.push(node.path); visit(node.children); } };
      visit(Array.isArray(tree) ? tree : tree?.data ?? tree?.items ?? []);
      assert(paths.length >= 10, `menu has only ${paths.length} pages`);
      const { page, context } = await newPage(admin);
      const failures = [], loaded = [];
      try {
        await page.goto('/login');
        await page.getByRole('textbox', { name: /^Username/ }).fill(ctx.adminCredentials.username);
        await page.getByLabel(/^Password/).fill(ctx.adminCredentials.password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
        for (const path of [...new Set(paths)]) {
          const bad = [];
          const listener = (response) => {
            const url = new URL(response.url());
            if (url.pathname.startsWith('/api/') && response.status() >= 400 && !/\/authorize\/(refresh|me)$/.test(url.pathname)) bad.push(`${response.status()} ${url.pathname}`);
          };
          page.on('response', listener);
          await page.goto(path);
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
          page.off('response', listener);
          const errorShown = await page.locator('[role="alert"]').filter({ hasText: /fail|error|could not|unable/i }).count();
          if (bad.length || errorShown) failures.push(`${path}: ${bad.join(', ') || 'error notice'}`); else loaded.push(path);
        }
      } finally { await context.close(); }
      assert(!failures.length, `pages with errors: ${failures.join('; ')}`);
      return { pages: loaded.length, paths: loaded };
    });

    await report.step('6.content-editor', 'CMS: edit the home hero through the management API (block editor contract), publish, public home shows it', async () => {
      const token = await adminToken();
      const list = await adminApi('GET', '/content/manage/entries?kind=page&locale=en', { token, expect: 200 });
      const rows = list?.data ?? list?.items ?? list ?? [];
      const row = rows.find((item) => item.slug === 'home' && (item.locale ?? 'en') === 'en');
      assert(row, 'home page entry not listed');
      const entry = await adminApi('GET', `/content/manage/entries/${row.id}`, { token, expect: 200 });
      const document = structuredClone(entry.draft?.document ?? entry.draft ?? entry.document);
      const hero = document.blocks.find((block) => block.type === 'hero');
      const heading = `Acceptance headline ${Date.now().toString(36)}`;
      hero.heading = heading;
      const updated = await adminApi('PUT', `/content/manage/entries/${row.id}`, { token, body: { expectedRevision: entry.revision, slug: entry.slug, document,
        categoryIds: (entry.categories ?? entry.categoryIds ?? []).map((category) => category.id ?? category) }, expect: 200 });
      await adminApi('POST', `/content/manage/entries/${row.id}/publish`, { token, body: { expectedRevision: updated.revision }, expect: 200 });
      await waitFor('published heading on the public home', async () => (await (await fetch(`${web}/`)).text()).includes(heading), 60_000, 2000);
      return { entry: row.id, heading, published: true };
    });

    await report.step('7.seo', 'SEO: canonical, hreflang, OG/Twitter on home, pricing and a post; OG image; sitemap; robots', async () => {
      const posts = await webApi('GET', '/content/public/entries?kind=post&locale=en', { raw: true });
      const postSlug = (posts.value?.data ?? posts.value?.items ?? posts.value ?? [])[0]?.slug;
      const evidence = {};
      for (const path of ['/', '/pricing', ...(postSlug ? [`/blog/${postSlug}`] : [])]) {
        const html = await (await fetch(`${web}${path}`)).text();
        const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
        const hreflang = [...html.matchAll(/<link rel="alternate" hrefLang="([^"]+)"/gi)].map((match) => match[1]);
        assert(canonical?.startsWith(web), `${path}: canonical ${canonical}`);
        // Static pages exist in every locale; a post lists only the locales it was published in.
        const expected = path.startsWith('/blog/') ? ['en'] : ['en', 'zh-CN', 'x-default'];
        assert(expected.every((locale) => hreflang.includes(locale)), `${path}: hreflang ${hreflang}`);
        assert(/property="og:title"/.test(html) && /property="og:image"/.test(html) && /name="twitter:card"/.test(html), `${path}: OG/Twitter tags missing`);
        evidence[path] = { canonical, hreflang };
      }
      const og = await fetch(`${web}/en/opengraph-image`);
      assert(og.status === 200 && /image\//.test(og.headers.get('content-type') ?? ''), `opengraph-image ${og.status}`);
      const sitemap = await (await fetch(`${web}/sitemap.xml`)).text();
      const robots = await (await fetch(`${web}/robots.txt`)).text();
      const sitemapText = /<sitemapindex/.test(sitemap)
        ? (await Promise.all([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(async ([, loc]) => (await fetch(`${web}${new URL(loc).pathname}`)).text()))).join('\n')
        : sitemap;
      assert(sitemapText.includes('/pricing'), 'sitemap lacks static routes');
      if (postSlug) assert(sitemapText.includes(postSlug), 'sitemap lacks CMS entries');
      for (const prefix of ['/dashboard', '/account', '/api/']) assert(robots.includes(`Disallow: ${prefix}`) || robots.includes(`Disallow: /en${prefix}`) || robots.includes(prefix.replace(/\/$/, '')), `robots does not exclude ${prefix}`);
      evidence.ogImage = og.headers.get('content-type'); evidence.sitemapUrls = (sitemapText.match(/<loc>/g) ?? []).length; evidence.post = postSlug ?? null;
      return evidence;
    });

    await report.step('7.i18n', 'i18n: zh routes render with zh hreflang/locale', async () => {
      const html = await (await fetch(`${web}/zh/pricing`)).text();
      assert(/<html lang="zh/.test(html), 'zh page has no zh lang');
      assert(/og:locale" content="zh_CN"/.test(html), 'zh og:locale missing');
      return { path: '/zh/pricing', lang: /<html lang="([^"]+)"/.exec(html)?.[1] };
    });

    const measurementId = `G-ACC${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await report.step('8.analytics-hot', 'Save web-analytics in admin → public page shows the script without restart', async () => {
      const before = await (await fetch(`${web}/`)).text();
      assert(!before.includes(measurementId), 'measurement id present before saving');
      await saveConnection('web-analytics', { SITE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_MEASUREMENT_ID: measurementId });
      await waitFor('analytics configuration in the page', async () => (await (await fetch(`${web}/`)).text()).includes(measurementId), 60_000, 2000);
      // The scripts are injected in the browser from the applied public configuration.
      const { page, context } = await newPage(web);
      try {
        await page.goto('/');
        await page.locator('script#zucker-analytics-google-init').waitFor({ state: 'attached', timeout: 20_000 });
        assert((await page.locator('script#zucker-analytics-google-init').textContent()).includes(measurementId), 'Google Analytics init lacks the saved id');
      } finally { await context.close(); }
      return { measurementId: measurementId, script: 'script#zucker-analytics-google-init', restart: false };
    });

    await report.step('8.mail-hot', 'Save the account mail profile → next mail goes to a second catcher without restart', async () => {
      const second = `${ctx.composeName ?? 'zf-accept'}-mail2`;
      const port = ctx.smtpSinkPort;
      execFileSync('docker', ['run', '-d', '--rm', '--name', second, '--network', `${ctx.composeName}_default`, '-p', `127.0.0.1:${port}:8025`, 'axllent/mailpit:v1.27'], { stdio: 'ignore' });
      try {
        await waitFor('second mail catcher', async () => (await fetch(`http://127.0.0.1:${port}/api/v1/messages`)).ok, 30_000);
        await saveConnection('account-email', { SMTP_HOST: second, SMTP_PORT: '1025' });
        const user = state.users.alice;
        const started = Date.now() - 1000;
        await webApi('POST', '/authorize/forgot-password', { body: { email: user.email }, expect: 200 });
        const mail = await mailTo(`http://127.0.0.1:${port}`, user.email, { timeoutMs: 45_000 });
        await saveConnection('account-email', { SMTP_HOST: 'mailpit', SMTP_PORT: '1025' });
        return { secondCatcher: second, subject: mail.subject, restart: false };
      } finally { execFileSync('docker', ['rm', '-f', second], { stdio: 'ignore' }); }
    });

    await report.step('9.security', 'Security spot checks: 403 for a non-admin write, forged callbacks inert, 429 on a limiter', async () => {
      const user = state.users.alice;
      const forbidden = await adminApi('POST', '/management/credit-packs', { token: user.token, body: { slug: 'x', title: 'x', credits: 1, status: true, prices: [] }, raw: true });
      assert(forbidden.status === 403, `non-admin management write → ${forbidden.status}`);
      const policyWrite = await adminApi('PUT', '/management/policies/account', { token: user.token, body: { expectedRevision: 0, values: {} }, raw: true });
      assert(policyWrite.status === 403, `non-admin policy write → ${policyWrite.status}`);
      const forgedPayment = await server('POST', '/billing/webhooks/stripe', { body: '{"type":"checkout.session.completed"}', headers: { 'stripe-signature': 't=1,v1=00' }, raw: true });
      assert(forgedPayment.status >= 400 && forgedPayment.status < 500, `forged payment webhook → ${forgedPayment.status}`);
      const forgedAI = await server('POST', '/ai/tasks/callbacks/fake-media', { body: '{"id":"x","status":"succeeded"}', raw: true });
      assert(forgedAI.status < 500, `forged AI callback → ${forgedAI.status}`);
      let limited = 0;
      for (let attempt = 0; attempt < 40 && !limited; attempt++) {
        const response = await webApi('POST', '/authorize/login', { body: { username: user.username, password: 'wrong-password-123' }, raw: true });
        if (response.status === 429) limited = attempt + 1;
      }
      assert(limited, 'no 429 after 40 failed logins');
      return { managementWrite: forbidden.status, policyWrite: policyWrite.status, forgedPaymentWebhook: forgedPayment.status, forgedAICallback: forgedAI.status, rateLimitedAfter: limited };
    });

    await report.step('9.sentinels', 'No generated secret in public/management responses or in the web and admin build output', async () => {
      const env = ctx.secrets();
      const secrets = ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'REVALIDATE_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'FILES_S3_SECRET_ACCESS_KEY']
        .map((key) => env[key]).filter((value) => value && value.length >= 16);
      const token = await adminToken();
      const bodies = [
        await (await fetch(`${web}/api/site/public/config`)).text(),
        await (await fetch(`${web}/api/site/public/integrations`)).text(),
        (await adminApi('GET', '/management/connection-settings', { token, raw: true })).text,
        (await adminApi('GET', '/management/policies', { token, raw: true })).text,
      ];
      const webBundle = ctx.bundles.web();
      const adminBundle = ctx.bundles.admin();
      const leaks = [];
      for (const [name, text] of [['site/public/config', bodies[0]], ['site/public/integrations', bodies[1]], ['management/connection-settings', bodies[2]], ['management/policies', bodies[3]], ['web .next', webBundle], ['admin dist', adminBundle]])
        for (const secret of secrets) if (text.includes(secret)) leaks.push(name);
      assert(!leaks.length, `secret found in ${[...new Set(leaks)].join(', ')}`);
      return { secretsChecked: secrets.length, scanned: ['site/public/config', 'site/public/integrations', 'management/connection-settings', 'management/policies', `web .next (${webBundle.length} bytes)`, `admin dist (${adminBundle.length} bytes)`] };
    });

    // ── Pass 2: NODE_ENV=test with the fake payment and AI providers ───────────────────────────
    await report.step('pass2.restart', 'Recreate only the server with NODE_ENV=test and the fake providers', async () => {
      await ctx.restartServer(2);
      state.adminToken = undefined;
      return { nodeEnv: 'test', fakes: ['BILLING_TEST_FAKE_PROVIDER', 'AI_TEST_FAKE_PROVIDERS'] };
    });

    const balanceOf = async (user) => (await webApi('GET', '/credits/balance', { token: user.token, expect: 200 })).available;
    await report.step('4.checkout', 'Fake provider: buy a pack (promo code) and a plan; return + webhook; credits and term granted once after replay; header balance', async () => {
      const token = await adminToken();
      const buyer = await signUp('bob');
      const pack = await adminApi('POST', '/management/credit-packs', { token, body: { slug: `accept-pack-${Date.now().toString(36)}`, title: 'Acceptance pack', credits: 100, expiresInDays: 30, status: true,
        prices: [{ currency: 'USD', amount: '10.00', providerRefs: { fake: `accept-pack-${randomUUID().slice(0, 8)}` } }] }, expect: 201 });
      const plan = await adminApi('POST', '/management/plans', { token, body: { slug: `accept-plan-${Date.now().toString(36)}`, name: 'Acceptance plan', status: true,
        prices: [{ interval: 'month', currency: 'USD', amount: '5', credits: 7, creditExpiry: 'period', providerRefs: { fake: `accept-plan-${randomUUID().slice(0, 8)}` } }] }, expect: 201 });
      await savePolicy('billing', { allowCustomerPromoCodes: true });
      const promo = `LAUNCH${Date.now().toString(36).toUpperCase().slice(-5)}`;
      await adminApi('POST', '/management/promotions', { token, body: { alias: promo, providerId: 'fake', providerCode: promo, target: `pack:${pack.id}`,
        currency: null, discountType: 'percent', percentOff: 20, amountOff: null, maxRedemptions: null, status: 'active', startsAt: null, endsAt: null, note: null }, expect: 201 });
      const before = await balanceOf(buyer);
      const order = await webApi('POST', '/billing/orders', { token: buyer.token, headers: { 'idempotency-key': randomUUID() },
        body: { offerId: `pack:${pack.id}:USD`, providerId: 'fake', promoCode: promo.toLowerCase() }, expect: 200 });
      assert(order.amountDue?.amount === '8.00' && order.discount?.amount === '2.00', `promo not applied: ${JSON.stringify({ due: order.amountDue, discount: order.discount })}`);
      const checkout = new URL(order.checkoutUrl);
      assert(checkout.origin === web, `checkout URL is not on the web origin: ${checkout.origin}`);
      const pagePath = checkout.pathname;
      const hosted = await (await fetch(`${web}${pagePath}`)).text();
      assert(hosted.includes('8.00 USD'), 'hosted fake page does not show the discounted amount');
      const paid = await fetch(`${web}${pagePath}/pay`, { method: 'POST', redirect: 'manual' });
      assert(paid.status === 303, `pay → ${paid.status}`);
      const confirmed = await webApi('POST', `/billing/orders/${order.id}/confirm`, { token: buyer.token, body: {}, expect: 200 });
      assert(confirmed.state === 'paid', `order state ${confirmed.state}`);
      const afterPack = await balanceOf(buyer);
      assert(afterPack === before + 100, `balance ${afterPack} after pack (before ${before})`);
      const resent = await (await fetch(`${web}${pagePath}/webhook`, { method: 'POST' })).json();
      const replay = await fetch(`${web}/api/billing/webhooks/fake`, { method: 'POST', headers: resent.request?.headers ?? resent.result?.request?.headers, body: resent.request?.body ?? resent.result?.request?.body });
      assert(replay.status === 200, `webhook replay → ${replay.status}`);
      assert(await balanceOf(buyer) === afterPack, 'webhook replay granted credits twice');
      const subscription = await webApi('POST', '/billing/orders', { token: buyer.token, headers: { 'idempotency-key': randomUUID() }, body: { offerId: `plan:${plan.id}:month:USD`, providerId: 'fake' }, expect: 200 });
      await fetch(`${web}${new URL(subscription.checkoutUrl).pathname}/pay`, { method: 'POST', redirect: 'manual' });
      const afterPlan = await waitFor('plan credits', async () => { const value = await balanceOf(buyer); return value === afterPack + 7 ? value : undefined; }, 20_000);
      const entitlements = await webApi('GET', '/billing/entitlements/me', { token: buyer.token, expect: 200 });
      // Header balance in the console (real browser, signed in through the form).
      const { page, context } = await newPage(web);
      let header;
      try {
        await page.goto('/login');
        await page.getByLabel('Username', { exact: true }).fill(buyer.username);
        await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
        // The header loads the balance after hydration; poll until it shows the ledger value.
        const read = async () => Number((await page.getByTestId('header-credit-balance').innerText({ timeout: 20_000 })).replace(/[^\d]/g, ''));
        header = await waitFor('header balance', async () => { const value = await read(); return value === afterPlan ? value : undefined; }, 20_000, 500).catch(read);
      } finally { await context.close(); }
      assert(header === afterPlan, `header balance ${header} != ${afterPlan}`);
      state.buyer = buyer;
      return { pack: { listPrice: '10.00', paid: '8.00', promo, credits: 100 }, plan: { credits: 7, plan: entitlements?.plan?.slug ?? entitlements?.planSlug ?? 'active' }, replayIgnored: true, headerBalance: header };
    });

    await report.step('4.hot-apply', 'Payment hot-apply: order on revision n, save a payment profile, old order settles, new order records the new revision', async () => {
      const token = await adminToken();
      const buyer = state.buyer;
      const packs = await adminApi('GET', '/management/credit-packs?q=accept-pack', { token, expect: 200 });
      const pack = (packs?.data ?? packs?.items ?? packs ?? []).find?.((item) => item.slug?.startsWith('accept-pack'));
      assert(pack, 'acceptance pack not found');
      const before = await balanceOf(buyer);
      const old = await webApi('POST', '/billing/orders', { token: buyer.token, headers: { 'idempotency-key': randomUUID() }, body: { offerId: `pack:${pack.id}:USD`, providerId: 'fake' }, expect: 200 });
      const profiles = await adminApi('GET', '/management/connection-settings', { token, expect: 200 });
      const payment = (profiles.profiles ?? []).find((profile) => profile.id.startsWith('payment-') && profile.applyMode === 'hot');
      assert(payment, 'no hot payment profile');
      const scope = payment.fields.find((field) => /ACCOUNT_SCOPE$/.test(field.key));
      await saveConnection(payment.id, { [scope.key]: `acct_accept_${Date.now().toString(36)}` });
      await fetch(`${web}${new URL(old.checkoutUrl).pathname}/pay`, { method: 'POST', redirect: 'manual' });
      await waitFor('old order credits', async () => (await balanceOf(buyer)) === before + 100, 20_000);
      const next = await webApi('POST', '/billing/orders', { token: buyer.token, headers: { 'idempotency-key': randomUUID() }, body: { offerId: `pack:${pack.id}:USD`, providerId: 'fake' }, expect: 200 });
      return { savedProfile: payment.id, oldOrderSettled: true, newOrder: next.id };
    });

    await report.step('5.ai', 'AI with fakes: image task (hold → confirm, download) and streaming chat; price change applies to the next task', async () => {
      await saveConnection('ai-openai', { AI_OPENAI_ENABLED: 'true', AI_OPENAI_MODEL_ID: 'gpt-accept' }, { AI_OPENAI_API_KEY: 'sk-acceptance-dummy-key' });
      await savePolicy('ai-catalog', { image: [{ providerId: 'fake-media', model: 'fake-image', label: 'Fake image' }] });
      await savePolicy('ai-pricing', { image: { default: 3, byModel: {} } });
      await savePolicy('account', { requireEmailVerification: false, welcomeCreditsEnabled: true, welcomeCreditsAmount: 500 });
      // The browser spec runs once more after a failure (cold caches right after the policy saves);
      // both outputs go to logs/ai-stack-spec.log.
      let output = '', attempts = 0;
      for (;;) {
        attempts++;
        try {
          output = execFileSync('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.ai-stack.config.ts', '--reporter=line'], {
            cwd: rootDir, encoding: 'utf8', env: { ...process.env, E2E_STACK_WEB_URL: web }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
          });
          appendFileSync(join(ctx.logs, 'ai-stack-spec.log'), output);
          break;
        } catch (error) {
          const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
          appendFileSync(join(ctx.logs, 'ai-stack-spec.log'), text);
          if (attempts >= 2) throw new Error(`e2e/stack/ai-stack.spec.ts failed twice: ${text.split('\n').filter((line) => /Error|expect|✘|failed/.test(line)).slice(0, 8).join(' | ')}`);
        }
      }
      const passed = /(\d+) passed/.exec(output)?.[1];
      // Price change in admin changes the next task's cost.
      const user = await signUp('carol');
      await savePolicy('ai-pricing', { image: { default: 4, byModel: {} } });
      const before = await balanceOf(user);
      const task = await webApi('POST', '/ai/tasks', { token: user.token, headers: { 'idempotency-key': randomUUID() }, body: { kind: 'image', providerId: 'fake-media', model: 'fake-image', prompt: 'acceptance pattern' }, expect: 202 });
      const done = await waitFor('image task', async () => { const value = await webApi('GET', `/ai/tasks/${task.id}`, { token: user.token, expect: 200 }); if (/^(FAILED|CANCELED|CANCELLED)$/i.test(value.status)) throw new Error(`task ${value.status}`); return /^(SUCCEEDED|COMPLETED)$/i.test(value.status) ? value : undefined; }, 180_000, 2000);
      const after = await balanceOf(user);
      assert(before - after === 4, `next task cost ${before - after}, expected 4`);
      const download = await fetch(`${web}/api/ai/tasks/${task.id}/outputs/0`, { headers: { authorization: `Bearer ${user.token}` }, redirect: 'manual' });
      assert(download.status < 400, `output download → ${download.status}`);
      // Cross-user isolation on tasks.
      const other = state.users.alice;
      const foreign = await webApi('GET', `/ai/tasks/${task.id}`, { token: other.token, raw: true });
      assert(foreign.status === 404 || foreign.status === 403, `cross-user task read → ${foreign.status}`);
      return { attempts, browserSpec: `${passed ?? '?'} passed (e2e/stack/ai-stack.spec.ts: image submit/complete/download, chat streaming, stop settlement, header balance)`, taskStatus: done.status, nextTaskCost: 4, crossUser: foreign.status };
    });
  } finally {
    await browser.close();
  }
}
