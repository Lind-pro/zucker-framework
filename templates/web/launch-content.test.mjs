import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

// Extensionless relative imports and the `@/` alias resolve to .ts; framework-only modules are stubbed.
const stub = (code) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const srcRoot = new URL('./src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return stub('export {}');
    if (specifier === 'react') return stub('export const cache = (fn) => fn');
    if (specifier === 'next/navigation') return stub('export const notFound = () => { throw new Error("notFound") }');
    if (specifier.startsWith('@/')) {
      const url = new URL(`${specifier.slice(2)}.ts`, srcRoot);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const pricing = await import('./src/features/billing/pricing.ts');
const rev = await import('./src/features/content/revalidate.ts');
const utm = await import('./src/features/landing/utm.ts');
const types = await import('./src/features/content/types.ts');
const { contentReadTags, CONTENT_REVALIDATE_SECONDS } = await import('./src/features/content/server.ts');

/* ------------------------------ pricing.ts ------------------------------ */

const price = (over = {}) => ({
  interval: 'month', currency: 'USD', amount: '19.90', termDays: 30, offerId: 'o1', purchasable: true,
  providers: ['stripe'], credits: 100, creditExpiry: 'period', ...over,
});
const plan = (over = {}) => ({ id: 'p1', slug: 'pro', name: 'Pro', order: 1, prices: [price()], features: { api: true, x: 'no' }, quotas: { calls: 5, bad: NaN }, ...over });
const catalog = (over = {}) => ({ plans: [plan()], packs: [], checkout: { defaultProvider: 'stripe', allowProviderChoice: true }, ...over });

test('parsePricingCatalog: rejects non-objects and missing plans array', () => {
  for (const bad of [null, undefined, 'x', 3, [], {}, { plans: 'x' }]) assert.throws(() => pricing.parsePricingCatalog(bad), /Invalid pricing response/);
});

test('parsePricingCatalog: drops malformed plans, packs and prices; keeps valid', () => {
  const parsed = pricing.parsePricingCatalog({
    plans: [
      plan({ id: 'b', slug: 'b', order: 2 }),
      { id: 1 },
      null,
      plan({ id: 'a', slug: 'a', order: 1, prices: [price({ amount: '1e3' }), price({ currency: 'usd' }), price({ interval: 'week' }), price({ amount: '5.5' }), 'x'] }),
    ],
    packs: [{ id: 'k', slug: 'k', title: 'K', credits: -1 }, { id: 'k2', slug: 'k2', title: 'K2', credits: 10, prices: [{ currency: 'USD', amount: '3', offerId: 'x', purchasable: true, providers: ['stripe'] }, { currency: 'USD', amount: 'abc' }] }],
  });
  assert.deepEqual(parsed.plans.map((p) => p.id), ['a', 'b']); // sorted by order
  assert.equal(parsed.plans[0].prices.length, 1);
  assert.equal(parsed.plans[0].prices[0].amount, '5.5');
  assert.deepEqual(parsed.plans[0].features, { api: true });
  assert.deepEqual(parsed.plans[0].quotas, { calls: 5 });
  assert.equal(parsed.packs.length, 1);
  assert.equal(parsed.packs[0].prices.length, 1);
});

test('parsePricingCatalog: amounts stay exact decimal strings (no float conversion)', () => {
  const amount = '900719925474099.12345678';
  const parsed = pricing.parsePricingCatalog({ plans: [plan({ prices: [price({ amount })] })] });
  assert.equal(parsed.plans[0].prices[0].amount, amount);
  assert.equal(pricing.parsePricingCatalog({ plans: [plan({ prices: [price({ amount: '1.123456789' })] })] }).plans[0].prices.length, 0);
  assert.equal(pricing.parsePricingCatalog({ plans: [plan({ prices: [price({ amount: 19.9 })] })] }).plans[0].prices.length, 0);
});

test('parsePricingCatalog: unpurchasable unless offer and providers both present', () => {
  const run = (over) => pricing.parsePricingCatalog({ plans: [plan({ prices: [price(over)] })] }).plans[0].prices[0];
  assert.equal(run({}).purchasable, true);
  for (const over of [{ offerId: null }, { offerId: '' }, { providers: [] }, { providers: [''] }, { purchasable: 'true' }, { purchasable: false }]) {
    const p = run(over);
    assert.equal(p.purchasable, false, JSON.stringify(over));
    assert.equal(p.offerId, null);
    assert.deepEqual(p.providers, []);
  }
});

test('parsePricingCatalog: credits, expiry, termDays, badge, current, checkout defaults', () => {
  const p = (over) => pricing.parsePricingCatalog({ plans: [plan({ prices: [price(over)] })] }).plans[0].prices[0];
  assert.equal(p({ creditExpiry: 30 }).creditExpiry, 30);
  assert.equal(p({ creditExpiry: 'period' }).creditExpiry, 'period');
  assert.equal(p({ creditExpiry: 'never' }).creditExpiry, null);
  assert.equal(p({ creditExpiry: -1 }).creditExpiry, null);
  assert.equal(p({ credits: 1.5 }).credits, 0);
  assert.equal(p({ termDays: -3 }).termDays, null);
  const out = pricing.parsePricingCatalog({ plans: [plan({ badge: '  ', current: 'yes', featured: true, highlights: ['a', 1, 'b'] })] });
  assert.equal(out.plans[0].badge, null);
  assert.equal(out.plans[0].current, false);
  assert.equal(out.plans[0].featured, true);
  assert.deepEqual(out.plans[0].highlights, ['a', 'b']);
  assert.deepEqual(out.checkout, { defaultProvider: null, allowProviderChoice: true, promoCodes: 'none' });
  assert.equal(pricing.parsePricingCatalog({ plans: [], checkout: { promoCodes: 'alias' } }).checkout.promoCodes, 'alias');
  assert.equal(pricing.parsePricingCatalog({ plans: [], checkout: { promoCodes: 'anything' } }).checkout.promoCodes, 'none');
  assert.equal(pricing.parsePricingCatalog({ plans: [], checkout: { allowProviderChoice: false, defaultProvider: '' } }).checkout.allowProviderChoice, false);
  assert.equal(pricing.parsePricingCatalog({ plans: [], checkout: { defaultProvider: '' } }).checkout.defaultProvider, null);
});

test('parseEntitlementCatalog', () => {
  assert.equal(pricing.parseEntitlementCatalog(null), null);
  assert.equal(pricing.parseEntitlementCatalog({ features: [] }), null);
  const out = pricing.parseEntitlementCatalog({
    features: [{ key: 'a', label: 'A', counter: 'c' }, { key: 1, label: 'x' }, 'x', { key: 'b', label: 'B' }],
    counters: [{ key: 'c', label: 'C', unit: 'req' }, { key: 'd', label: 'D' }, { label: 'no key' }],
  });
  assert.deepEqual(out.features, [{ key: 'a', label: 'A', counter: 'c' }, { key: 'b', label: 'B' }]);
  assert.deepEqual(out.counters, [{ key: 'c', label: 'C', unit: 'req' }, { key: 'd', label: 'D', unit: '' }]);
});

test('currencies, default currency and intervals', () => {
  const cat = pricing.parsePricingCatalog({
    plans: [
      plan({ id: 'a', slug: 'a', prices: [price({ currency: 'USD' }), price({ currency: 'CNY', interval: 'year', amount: '99' })] }),
      plan({ id: 'b', slug: 'b', order: 2, prices: [price({ currency: 'CNY', amount: '9' }), price({ currency: 'USD', interval: 'lifetime' })] }),
    ],
    packs: [{ id: 'k', slug: 'k', title: 'K', credits: 5, prices: [{ currency: 'EUR', amount: '1' }] }],
  });
  assert.deepEqual(pricing.pricingCurrencies(cat), ['CNY', 'EUR', 'USD']);
  assert.equal(pricing.defaultCurrency(cat, 'EUR'), 'EUR');
  assert.equal(pricing.defaultCurrency(cat, 'JPY'), 'CNY'); // CNY and USD tie at 2 -> alphabetical
  assert.equal(pricing.defaultCurrency(cat), 'CNY');
  assert.equal(pricing.defaultCurrency({ plans: [], packs: [], checkout: {} }), null);
  assert.deepEqual(pricing.pricingIntervals(cat, 'USD'), ['month', 'lifetime']);
  assert.deepEqual(pricing.pricingIntervals(cat, 'CNY'), ['month', 'year']);
  assert.deepEqual(pricing.pricingIntervals(cat, null), []);
});

test('buildPricingView: selection, fallbacks, slug filter, packs by currency', () => {
  const cat = pricing.parsePricingCatalog({
    plans: [
      plan({ id: 'a', slug: 'a', prices: [price(), price({ interval: 'year', amount: '199' })] }),
      plan({ id: 'b', slug: 'b', order: 2, prices: [price({ interval: 'year', amount: '299' })] }),
    ],
    packs: [{ id: 'k', slug: 'k', title: 'K', credits: 5, prices: [{ currency: 'USD', amount: '1' }, { currency: 'EUR', amount: '2' }] }],
  });
  let v = pricing.buildPricingView(cat);
  assert.equal(v.currency, 'USD');
  assert.equal(v.interval, 'month');
  assert.deepEqual(v.plans.map((x) => x.plan.slug), ['a']); // b has no month price
  v = pricing.buildPricingView(cat, { interval: 'year' });
  assert.deepEqual(v.plans.map((x) => x.plan.slug), ['a', 'b']);
  v = pricing.buildPricingView(cat, { interval: 'nonsense', currency: 'XXX' });
  assert.equal(v.interval, 'month');
  assert.equal(v.currency, 'USD');
  v = pricing.buildPricingView(cat, { plans: ['b', 'zzz'] });
  assert.deepEqual(v.intervals, ['year']);
  assert.deepEqual(v.plans.map((x) => x.plan.slug), ['b']);
  assert.deepEqual(pricing.buildPricingView(cat, { plans: ['b', 'a'], interval: 'year' }).plans.map((x) => x.plan.slug), ['b', 'a']); // display order of the list
  v = pricing.buildPricingView(cat, { currency: 'EUR' });
  assert.equal(v.packs[0].price.amount, '2');
  assert.deepEqual(v.plans, []); // no EUR plan prices
  assert.equal(v.interval, null);
  const empty = pricing.buildPricingView({ plans: [], packs: [], checkout: { defaultProvider: null, allowProviderChoice: true } });
  assert.equal(empty.currency, null);
  assert.deepEqual(empty.plans, []);
});

test('checkoutProviders honours allowProviderChoice', () => {
  const on = { defaultProvider: 'alipay', allowProviderChoice: true };
  const off = { defaultProvider: 'alipay', allowProviderChoice: false };
  assert.deepEqual(pricing.checkoutProviders(['stripe', 'alipay'], on), { providers: ['stripe', 'alipay'], selected: 'alipay', choice: true });
  assert.deepEqual(pricing.checkoutProviders(['stripe'], on), { providers: ['stripe'], selected: 'stripe', choice: false });
  assert.deepEqual(pricing.checkoutProviders(['stripe', 'alipay'], off), { providers: ['alipay'], selected: 'alipay', choice: false });
  assert.deepEqual(pricing.checkoutProviders(['stripe', 'wechat'], off), { providers: ['stripe'], selected: 'stripe', choice: false });
  assert.deepEqual(pricing.checkoutProviders([], off), { providers: [], selected: null, choice: false });
  assert.deepEqual(pricing.checkoutProviders([], on), { providers: [], selected: null, choice: false });
});

test('formatMoney keeps server decimals and falls back on bad currency', () => {
  assert.equal(pricing.formatMoney('19.90', 'USD', 'en'), '$19.90');
  assert.equal(pricing.formatMoney('20', 'USD', 'en'), '$20');
  assert.equal(pricing.formatMoney('0.123', 'USD', 'en'), '$0.123');
  assert.equal(pricing.formatMoney('19.90', 'ZZZZ', 'en'), 'ZZZZ 19.90');
  assert.match(pricing.formatMoney('99', 'CNY', 'zh'), /99/);
});

test('planEntitlements and isPlanInterval', () => {
  const ent = { features: [{ key: 'api', label: 'API', counter: 'calls' }, { key: 'sso', label: 'SSO' }, { key: 'off', label: 'Off' }, { key: 'orph', label: 'Orph', counter: 'gone' }], counters: [{ key: 'calls', label: 'Calls', unit: '/mo' }] };
  const p = { features: { api: true, sso: true, off: false, orph: true }, quotas: { calls: -1, gone: 3 } };
  assert.deepEqual(pricing.planEntitlements(p, ent), [
    { key: 'api', label: 'API', limit: -1, unit: '/mo' },
    { key: 'sso', label: 'SSO' },
    { key: 'orph', label: 'Orph' },
  ]);
  assert.deepEqual(pricing.planEntitlements(p, null), []);
  assert.equal(pricing.isPlanInterval('month'), true);
  assert.equal(pricing.isPlanInterval('week'), false);
});

/* ----------------------------- revalidate.ts ---------------------------- */

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;
const ts = String(NOW / 1000);
const body = JSON.stringify({ tags: ['content', 'content:entry:page:en:home'] });
const req = (over = {}) => {
  const rawBody = over.rawBody ?? body;
  const timestamp = over.timestamp === undefined ? ts : over.timestamp;
  return { secret: SECRET, timestamp, signature: over.signature === undefined ? rev.signRevalidation(SECRET, timestamp ?? '', rawBody) : over.signature, rawBody, now: NOW };
};

test('revalidate: valid request returns deduped tags; signature over `${ts}.${rawBody}`', async () => {
  const { createHmac } = await import('node:crypto');
  assert.equal(rev.signRevalidation(SECRET, ts, body), `v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`);
  assert.deepEqual(rev.verifyRevalidation(req()), { ok: true, tags: ['content', 'content:entry:page:en:home'] });
  const dup = JSON.stringify({ tags: ['a', 'a', 'b'] });
  assert.deepEqual(rev.verifyRevalidation(req({ rawBody: dup, signature: undefined })).tags, ['a', 'b']);
});

test('revalidate: timestamp window is +-300s inclusive and rejects malformed', () => {
  const at = (delta) => String(NOW / 1000 + delta);
  const sign = (t) => ({ timestamp: t, signature: rev.signRevalidation(SECRET, t, body) });
  assert.equal(rev.verifyRevalidation(req(sign(at(300)))).ok, true);
  assert.equal(rev.verifyRevalidation(req(sign(at(-300)))).ok, true);
  for (const d of [301, -301, 3600]) assert.equal(rev.verifyRevalidation(req(sign(at(d)))).status, 401, String(d));
  for (const bad of [null, '', 'abc', '-5', '1.5', '1'.repeat(13)]) {
    const v = rev.verifyRevalidation(req({ timestamp: bad, signature: rev.signRevalidation(SECRET, bad ?? '', body) }));
    assert.equal(v.ok, false, String(bad));
    assert.equal(v.status, 401);
  }
});

test('revalidate: signature failures are 401', () => {
  for (const signature of [null, '', 'v1=', 'v1=zz', rev.signRevalidation(SECRET, ts, body).slice(3), rev.signRevalidation(SECRET, ts, body).toUpperCase(), rev.signRevalidation('t'.repeat(40), ts, body), rev.signRevalidation(SECRET, ts, body) + '0'])
    assert.deepEqual([rev.verifyRevalidation(req({ signature })).ok, rev.verifyRevalidation(req({ signature })).status], [false, 401], String(signature));
  // body tampering, one flipped byte
  assert.equal(rev.verifyRevalidation(req({ rawBody: body.replace('content', 'contenu'), signature: rev.signRevalidation(SECRET, ts, body) })).status, 401);
  // timestamp bound into the signature
  assert.equal(rev.verifyRevalidation(req({ signature: rev.signRevalidation(SECRET, String(NOW / 1000 - 1), body) })).status, 401);
  // whitespace-padded header values are tolerated
  assert.equal(rev.verifyRevalidation(req({ signature: ` ${rev.signRevalidation(SECRET, ts, body)} ` })).ok, true);
});

test('revalidate: signature is checked over raw bytes before JSON is parsed', () => {
  const pretty = '{ "tags" : ["content"] }';
  assert.equal(rev.verifyRevalidation(req({ rawBody: pretty })).ok, true);
  // unsigned malformed JSON must be 401 (not 400) so nothing leaks before authentication
  assert.equal(rev.verifyRevalidation(req({ rawBody: '{nope', signature: 'v1=' + '0'.repeat(64) })).status, 401);
  // signed malformed JSON is 400
  assert.equal(rev.verifyRevalidation(req({ rawBody: '{nope' })).status, 400);
});

test('revalidate: size limit 16 KiB is bytes, checked first', () => {
  const edge = (n) => `{"tags":["a"],"pad":"${'x'.repeat(n)}"}`;
  const big = 'é'.repeat(8 * 1024 + 1); // 16 KiB + 2 bytes in UTF-8, but only ~8 KiB chars
  const v = rev.verifyRevalidation(req({ rawBody: big }));
  assert.deepEqual([v.ok, v.status], [false, 413]);
  assert.equal(rev.verifyRevalidation({ ...req({ rawBody: edge(20000) }), signature: 'garbage' }).status, 413);
  const exact = '{"tags":["a"]}' + ' '.repeat(rev.REVALIDATE_MAX_BODY_BYTES - 14);
  assert.equal(Buffer.byteLength(exact), 16384);
  assert.equal(rev.verifyRevalidation(req({ rawBody: exact })).ok, true);
  assert.equal(rev.verifyRevalidation(req({ rawBody: exact + ' ' })).status, 413);
});

test('revalidate: body shape and tag validation are 400', () => {
  const signed = (value) => rev.verifyRevalidation(req({ rawBody: typeof value === 'string' ? value : JSON.stringify(value), signature: undefined }));
  const bad = [
    [], 'null', '"x"', '3', { tags: [] }, { tags: 'content' }, { tags: ['a'], extra: 1 }, { other: ['a'] }, {},
    { tags: [1] }, { tags: ['A'] }, { tags: [':a'] }, { tags: ['a b'] }, { tags: ['a\n'] }, { tags: [''] }, { tags: ['a'.repeat(257)] },
    { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }, { tags: ['ok', null] },
  ];
  for (const value of bad) {
    const v = signed(value);
    assert.deepEqual([v.ok, v.status], [false, 400], JSON.stringify(value));
  }
  assert.equal(signed({ tags: Array.from({ length: 32 }, (_, i) => `t${i}`) }).ok, true);
  assert.equal(signed({ tags: ['a'.repeat(256)] }).ok, true);
  assert.equal(signed({ tags: ['a:b/c_d-e', '9x'] }).ok, true);
});

test('revalidate: ReplayGuard accepts once per signature, expires and is bounded', () => {
  const g = new rev.ReplayGuard(3);
  assert.equal(g.accept('a', 0), true);
  assert.equal(g.accept('a', 1000), false);
  assert.equal(g.accept('b', 2000), true);
  // after 2*window the entry is forgotten
  assert.equal(g.accept('a', 2 * rev.REVALIDATE_WINDOW_SECONDS * 1000 + 1), true);
  // bounded: size never exceeds max, oldest evicted
  const h = new rev.ReplayGuard(2);
  h.accept('x', 0); h.accept('y', 1); h.accept('z', 2);
  assert.equal(h.seen.size, 2);
  assert.equal(h.accept('x', 3), true); // evicted, accepted again (idempotent revalidation, bounded memory)
});

/* -------------------------------- utm.ts -------------------------------- */

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), m };
};

test('utm: sanitizeUtmSource', () => {
  assert.equal(utm.sanitizeUtmSource(' google.ads_1-x '), 'google.ads_1-x');
  for (const bad of [null, 5, '', 'a b', 'a;b', '<script>', 'x'.repeat(65), 'é', 'a\nb']) assert.equal(utm.sanitizeUtmSource(bad), null, String(bad));
  assert.equal(utm.sanitizeUtmSource('x'.repeat(64)), 'x'.repeat(64));
});

test('utm: first touch wins, window of 30 days, invalid values ignored', () => {
  const s = memory();
  utm.captureUtmSource('?utm_source=bing', s, 1000);
  assert.equal(utm.readUtmSource(s, 2000), 'bing');
  utm.captureUtmSource('?utm_source=google', s, 3000);
  assert.equal(utm.readUtmSource(s, 4000), 'bing');
  assert.equal(utm.readUtmSource(s, 1000 + utm.UTM_MAX_AGE_MS), 'bing');
  assert.equal(utm.readUtmSource(s, 1000 + utm.UTM_MAX_AGE_MS + 1), null);
  // expired touch may be replaced
  utm.captureUtmSource('?utm_source=google', s, 1000 + utm.UTM_MAX_AGE_MS + 5);
  assert.equal(utm.readUtmSource(s, 1000 + utm.UTM_MAX_AGE_MS + 6), 'google');
  const t = memory();
  utm.captureUtmSource('?utm_source=bad%20value', t, 1);
  utm.captureUtmSource('?utm_medium=cpc', t, 1);
  utm.captureUtmSource('', t, 1);
  assert.equal(t.m.size, 0);
});

test('utm: corrupt, future-dated and hostile storage never throws', () => {
  const key = utm.UTM_STORAGE_KEY;
  for (const raw of ['{', 'null', '"x"', '{"source":"a"}', '{"source":"a","at":"1"}', JSON.stringify({ source: 'bad value', at: 1 }), JSON.stringify({ source: 'a', at: 10_000 })]) {
    const s = memory(); s.setItem(key, raw);
    assert.equal(utm.readUtmSource(s, 5000), null, raw);
  }
  assert.equal(utm.readUtmSource(null), null);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(utm.readUtmSource(throwing, 1), null);
  assert.doesNotThrow(() => utm.captureUtmSource('?utm_source=x', throwing, 1));
  const writeDenied = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.doesNotThrow(() => utm.captureUtmSource('?utm_source=x', writeDenied, 1));
  assert.doesNotThrow(() => utm.captureUtmSource('?utm_source=x', null, 1));
});

/* ----------------------- content types / read tags ---------------------- */

test('contentPath', () => {
  assert.equal(types.contentPath('page', 'home'), '/');
  assert.equal(types.contentPath('page', 'about'), '/about');
  assert.equal(types.contentPath('post', 'hello'), '/blog/hello');
  assert.equal(types.contentPath('doc', 'guide'), '/docs/guide');
  assert.equal(types.contentPath('log', 'v1-0'), '/changelog/v1-0');
  assert.equal(types.contentPath('post', 'home'), '/blog/home');
});

test('localizedHref: no redirect hop, default locale unprefixed', () => {
  const l = types.localizedHref;
  assert.equal(l('/pricing', 'en'), '/pricing');
  assert.equal(l('/pricing', 'zh'), '/zh/pricing');
  assert.equal(l('/', 'zh'), '/zh');
  assert.equal(l('/?a=1', 'zh'), '/zh?a=1');
  assert.equal(l('/zh/pricing', 'en'), '/zh/pricing'); // already carries a non-default locale
  assert.equal(l('/en/pricing', 'zh'), '/pricing'); // redundant default prefix dropped
  assert.equal(l('/en', 'zh'), '/');
  assert.equal(l('/en?x=1', 'en'), '/?x=1');
  assert.equal(l('/en#h', 'en'), '/#h');
  assert.equal(l('/english', 'zh'), '/zh/english'); // not a locale prefix
  assert.equal(l('https://x.example/a', 'zh'), 'https://x.example/a');
  assert.equal(l('//cdn.example/a', 'zh'), '//cdn.example/a');
  assert.equal(l('#top', 'zh'), '#top');
  assert.equal(l('mailto:a@b.c', 'zh'), 'mailto:a@b.c');
  assert.equal(l('/pricing', 'fr'), '/pricing'); // unknown locale -> unchanged
});

test('contentReadTags match the Server tag scheme; search is uncached', () => {
  assert.equal(CONTENT_REVALIDATE_SECONDS, 3600);
  assert.deepEqual(contentReadTags('entry', { kind: 'page', locale: 'en', slug: 'home' }), ['content', 'content:entry:page:en:home']);
  assert.deepEqual(contentReadTags('entries', { kind: 'log', locale: 'zh', page: '2' }), ['content', 'content:list:log:zh']);
  assert.deepEqual(contentReadTags('categories', { locale: 'en' }), ['content', 'content:categories:en']);
  assert.deepEqual(contentReadTags('settings', {}), ['content', 'content:settings']);
  assert.deepEqual(contentReadTags('sitemap', {}), ['content', 'content:sitemap']);
  assert.equal(contentReadTags('search', { q: 'x' }), null);
  assert.equal(contentReadTags('unknown', {}), null);
  // every emitted tag is accepted by the receiver
  for (const tags of [contentReadTags('entry', { kind: 'doc', locale: 'en', slug: 'a-b_c' }), contentReadTags('sitemap', {})])
    assert.equal(rev.verifyRevalidation(req({ rawBody: JSON.stringify({ tags }), signature: undefined })).ok, true);
});
