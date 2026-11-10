import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source files use extensionless relative imports (bundler resolution); resolve them to .ts for node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const base = './src/lib/site/';
const { buildMetadata, openGraphImagePath } = await import(base + 'metadata.ts');
const { buildUrlsetXml, buildSitemapIndexXml, staticSitemapUrls, xmlEscape } = await import(base + 'sitemap.ts');
const { cacheControlFor, PUBLIC_CACHE_CONTROL, PRIVATE_CACHE_CONTROL, stripLocale, isProtectedPath } = await import(base + 'cache-policy.ts');
const { localizedPath, localizedUrl, parseSiteOrigin, parseAdminUrl } = await import(base + 'url.ts');
const { preferredLocale, resolveDefaultLocale, isLocale } = await import(base + 'locales.ts');
const { isConsoleNavActive, consoleNav } = await import(base + 'console-nav.ts');
const { staticSitemapRoutes } = await import(base + 'sitemap-routes.ts');

const origin = 'https://site.example.invalid';

test('localizedPath: default locale unprefixed, others prefixed', () => {
  assert.equal(localizedPath('en', '/pricing', 'en'), '/pricing');
  assert.equal(localizedPath('zh', '/pricing', 'en'), '/zh/pricing');
  assert.equal(localizedPath('zh', '/', 'en'), '/zh');
  assert.equal(localizedPath('zh', '/?a=1', 'en'), '/zh?a=1');
  assert.equal(localizedPath('en', '/', 'zh'), '/en');
  assert.equal(localizedPath('zh', '/', 'zh'), '/');
  assert.throws(() => localizedPath('en', 'pricing', 'en'));
  assert.throws(() => localizedPath('en', '//evil.example', 'en'));
  assert.equal(localizedUrl(origin, 'zh', '/blog/x', 'en'), `${origin}/zh/blog/x`);
});

test('parseSiteOrigin accepts origins only', () => {
  assert.equal(parseSiteOrigin('https://a.example/'), 'https://a.example');
  assert.equal(parseSiteOrigin(undefined), 'http://localhost:4202');
  assert.equal(parseSiteOrigin('  '), 'http://localhost:4202');
  assert.equal(parseSiteOrigin('http://a.example:8080'), 'http://a.example:8080');
  for (const bad of ['https://a.example/path', 'https://a.example/?q=1', 'https://a.example/#x', 'https://u:p@a.example', 'ftp://a.example', 'javascript:alert(1)'])
    assert.throws(() => parseSiteOrigin(bad), bad);
  assert.throws(() => parseSiteOrigin('not a url'));
});

test('parseAdminUrl', () => {
  assert.equal(parseAdminUrl(''), null);
  assert.equal(parseAdminUrl(undefined), null);
  assert.equal(parseAdminUrl('garbage'), null);
  assert.equal(parseAdminUrl('javascript:alert(1)'), null);
  assert.equal(parseAdminUrl('https://u:p@a.example'), null);
  assert.equal(parseAdminUrl('https://admin.example/'), 'https://admin.example/');
});

test('locale helpers', () => {
  assert.equal(resolveDefaultLocale(undefined), 'en');
  assert.equal(resolveDefaultLocale(' '), 'en');
  assert.equal(resolveDefaultLocale('zh'), 'zh');
  assert.throws(() => resolveDefaultLocale('fr'));
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('fr'), false);
  assert.equal(isLocale(undefined), false);
});

test('preferredLocale', () => {
  assert.equal(preferredLocale(['zh-CN', 'en']), 'zh');
  assert.equal(preferredLocale(['fr-FR', 'en-US']), 'en');
  assert.equal(preferredLocale(['ZH_tw']), 'zh');
  assert.equal(preferredLocale(['fr', 'de']), undefined);
  assert.equal(preferredLocale([]), undefined);
  assert.equal(preferredLocale(['zh;q=0.8']), 'zh');
  assert.equal(preferredLocale(['*']), undefined);
  assert.equal(preferredLocale(['  en-GB ']), 'en');
});

test('cacheControlFor decision table', () => {
  const table = [
    ['GET', '/', undefined, PUBLIC_CACHE_CONTROL],
    ['GET', '/pricing', undefined, PUBLIC_CACHE_CONTROL],
    ['HEAD', '/blog/hello', undefined, PUBLIC_CACHE_CONTROL],
    ['GET', '/docs/search', undefined, PUBLIC_CACHE_CONTROL],
    ['GET', '/accountant', undefined, PUBLIC_CACHE_CONTROL],
    ['GET', '/login', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/register', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/oauth/callback', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/forgot-password', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/reset-password', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/verify-email', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/account', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/account/credits', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/billing/orders', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/dashboard', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/content/manage', undefined, PRIVATE_CACHE_CONTROL],
    ['POST', '/pricing', undefined, PRIVATE_CACHE_CONTROL],
    ['PUT', '/', undefined, PRIVATE_CACHE_CONTROL],
    ['GET', '/pricing', true, PRIVATE_CACHE_CONTROL],
    ['GET', '/account', true, PRIVATE_CACHE_CONTROL],
  ];
  for (const [method, path, redirect, expected] of table)
    assert.equal(cacheControlFor({ method, path, redirect }), expected, `${method} ${path} redirect=${redirect}`);
  assert.equal(PUBLIC_CACHE_CONTROL, 'public, s-maxage=3600, stale-while-revalidate=14400');
});

test('stripLocale / isProtectedPath', () => {
  assert.deepEqual(stripLocale('/zh/account/credits'), { locale: 'zh', path: '/account/credits' });
  assert.deepEqual(stripLocale('/zh'), { locale: 'zh', path: '/' });
  assert.deepEqual(stripLocale('/en/'), { locale: 'en', path: '/' });
  assert.deepEqual(stripLocale('/pricing'), { locale: undefined, path: '/pricing' });
  assert.deepEqual(stripLocale('/zhx/a'), { locale: undefined, path: '/zhx/a' });
  assert.equal(isProtectedPath('/account'), true);
  assert.equal(isProtectedPath('/login'), false);
});

test('buildMetadata: default-locale prefix rule, alternates, x-default', () => {
  const en = buildMetadata({ locale: 'en', path: '/pricing', title: 'Pricing', description: 'D', origin, defaultLocale: 'en', siteName: 'S' });
  assert.equal(en.alternates.canonical, `${origin}/pricing`);
  assert.deepEqual(en.alternates.languages, { en: `${origin}/pricing`, 'zh-CN': `${origin}/zh/pricing`, 'x-default': `${origin}/pricing` });
  assert.equal(en.openGraph.url, `${origin}/pricing`);
  assert.equal(en.openGraph.locale, 'en_US');
  assert.deepEqual(en.openGraph.alternateLocale, ['zh_CN']);
  assert.equal(en.openGraph.siteName, 'S');
  assert.deepEqual(en.openGraph.images, [{ url: `${origin}/en/opengraph-image`, width: 1200, height: 630 }]);
  assert.equal(en.twitter.card, 'summary_large_image');
  assert.deepEqual(en.twitter.images, [`${origin}/en/opengraph-image`]);
  assert.deepEqual(en.robots, { index: true, follow: true });

  const zh = buildMetadata({ locale: 'zh', path: '/pricing', title: 'T', origin, defaultLocale: 'en' });
  assert.equal(zh.alternates.canonical, `${origin}/zh/pricing`);
  assert.equal(zh.alternates.languages['x-default'], `${origin}/pricing`);
  assert.equal(zh.openGraph.locale, 'zh_CN');
  assert.deepEqual(zh.openGraph.alternateLocale, ['en_US']);
  assert.equal(zh.description, undefined);
  assert.equal('description' in zh.openGraph, false);
  assert.equal(zh.openGraph.images[0].url, `${origin}/zh/opengraph-image`);

  const root = buildMetadata({ locale: 'en', path: '/', title: 'H', origin, defaultLocale: 'en' });
  assert.equal(root.alternates.canonical, `${origin}/`);
  assert.equal(root.alternates.languages['zh-CN'], `${origin}/zh`);

  // default locale zh: zh unprefixed, en prefixed, x-default -> zh
  const zhDefault = buildMetadata({ locale: 'en', path: '/pricing', title: 'T', origin, defaultLocale: 'zh' });
  assert.equal(zhDefault.alternates.canonical, `${origin}/en/pricing`);
  assert.equal(zhDefault.alternates.languages['zh-CN'], `${origin}/pricing`);
  assert.equal(zhDefault.alternates.languages['x-default'], `${origin}/pricing`);
});

test('buildMetadata: noIndex, alternateLocales, image, article', () => {
  const noindex = buildMetadata({ locale: 'en', path: '/x', title: 'T', noIndex: true, origin, defaultLocale: 'en' });
  assert.deepEqual(noindex.robots, { index: false, follow: true });

  const single = buildMetadata({ locale: 'zh', path: '/blog/a', title: 'T', alternateLocales: ['zh'], origin, defaultLocale: 'en' });
  assert.deepEqual(single.alternates.languages, { 'zh-CN': `${origin}/zh/blog/a` });
  assert.deepEqual(single.openGraph.alternateLocale, []);
  assert.equal(single.alternates.canonical, `${origin}/zh/blog/a`);

  const dup = buildMetadata({ locale: 'en', path: '/x', title: 'T', alternateLocales: ['en', 'en'], origin, defaultLocale: 'en' });
  assert.deepEqual(Object.keys(dup.alternates.languages), ['en']);

  const enOnlyNonDefault = buildMetadata({ locale: 'zh', path: '/x', title: 'T', alternateLocales: ['zh', 'en'], origin, defaultLocale: 'en' });
  assert.equal(enOnlyNonDefault.alternates.languages['x-default'], `${origin}/x`);
  const noDefaultAvail = buildMetadata({ locale: 'zh', path: '/x', title: 'T', alternateLocales: ['zh'], origin, defaultLocale: 'en' });
  assert.equal('x-default' in noDefaultAvail.alternates.languages, false);

  const noImage = buildMetadata({ locale: 'en', path: '/x', title: 'T', image: false, origin, defaultLocale: 'en' });
  assert.equal('images' in noImage.openGraph, false);
  assert.equal('images' in noImage.twitter, false);
  const rel = buildMetadata({ locale: 'en', path: '/x', title: 'T', image: '/img/a.png', origin, defaultLocale: 'en' });
  assert.equal(rel.openGraph.images[0].url, `${origin}/img/a.png`);

  const article = buildMetadata({ locale: 'en', path: '/blog/a', title: 'T', type: 'article', publishedTime: '2026-01-01', authors: ['A'], origin, defaultLocale: 'en' });
  assert.equal(article.openGraph.type, 'article');
  assert.equal(article.openGraph.publishedTime, '2026-01-01');
  assert.deepEqual(article.openGraph.authors, ['A']);
  const website = buildMetadata({ locale: 'en', path: '/', title: 'T', publishedTime: '2026-01-01', origin, defaultLocale: 'en' });
  assert.equal('publishedTime' in website.openGraph, false);
  assert.equal(openGraphImagePath('zh'), '/zh/opengraph-image');
});

test('buildMetadata: canonical derives only from SITE_URL, never request host or path tricks', () => {
  const previous = process.env.SITE_URL;
  process.env.SITE_URL = 'https://configured.example.invalid';
  try {
    const meta = buildMetadata({ locale: 'en', path: '/pricing', title: 'T', defaultLocale: 'en' });
    assert.equal(meta.alternates.canonical, 'https://configured.example.invalid/pricing');
    for (const url of Object.values(meta.alternates.languages)) assert(url.startsWith('https://configured.example.invalid/'), url);
    assert(meta.openGraph.images[0].url.startsWith('https://configured.example.invalid/'));
  } finally {
    if (previous === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = previous;
  }
  assert.throws(() => buildMetadata({ locale: 'en', path: '//evil.example/x', title: 'T', origin, defaultLocale: 'en' }));
  assert.throws(() => buildMetadata({ locale: 'en', path: 'pricing', title: 'T', origin, defaultLocale: 'en' }));
});

test('sitemap builders', () => {
  assert.equal(xmlEscape(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const urls = staticSitemapUrls(origin, ['/', '/pricing'], ['en', 'zh'], 'en');
  assert.deepEqual(urls.map((u) => u.loc), [`${origin}/`, `${origin}/zh`, `${origin}/pricing`, `${origin}/zh/pricing`]);
  assert.deepEqual(urls[1].alternates, [
    { hreflang: 'en', href: `${origin}/` },
    { hreflang: 'zh-CN', href: `${origin}/zh` },
    { hreflang: 'x-default', href: `${origin}/` },
  ]);
  const xml = buildUrlsetXml(urls);
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'));
  assert(xml.endsWith('</urlset>'));
  assert(xml.includes(`<loc>${origin}/zh/pricing</loc>`));
  assert(xml.includes(`<xhtml:link rel="alternate" hreflang="zh-CN" href="${origin}/zh/pricing"/>`));
  assert.equal((xml.match(/<url>/g) ?? []).length, 4);

  const plain = buildUrlsetXml([{ loc: 'https://a.example/?a=1&b=2', lastmod: '2026-01-01' }]);
  assert(!plain.includes('xmlns:xhtml'));
  assert(plain.includes('<loc>https://a.example/?a=1&amp;b=2</loc><lastmod>2026-01-01</lastmod>'));
  assert.equal(buildUrlsetXml([]), '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');

  const single = staticSitemapUrls(origin, ['/'], ['en'], 'en');
  assert.equal(single[0].alternates.length, 1); // no x-default for a single locale
  assert.equal(buildSitemapIndexXml([`${origin}/sitemaps/0.xml`, 'https://a.example/x?a=1&b=2']),
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemaps/0.xml</loc></sitemap><sitemap><loc>https://a.example/x?a=1&amp;b=2</loc></sitemap></sitemapindex>`);
  for (const route of ['/', '/pricing', '/blog', '/docs', '/changelog']) assert(staticSitemapRoutes.includes(route), route);
});

test('isConsoleNavActive', () => {
  const item = (href, match) => ({ id: 'x', href, label: { en: '', zh: '' }, order: 1, match });
  assert.equal(isConsoleNavActive(item('/account', 'exact'), '/account'), true);
  assert.equal(isConsoleNavActive(item('/account', 'exact'), '/account/credits'), false);
  assert.equal(isConsoleNavActive(item('/account/credits'), '/account/credits'), true);
  assert.equal(isConsoleNavActive(item('/account/credits'), '/account/credits/x'), true);
  assert.equal(isConsoleNavActive(item('/account/credits'), '/account/creditsx'), false);
  assert.equal(isConsoleNavActive(item('/account/credits', 'prefix'), '/account'), false);
  assert.equal(isConsoleNavActive(item('/account#security'), '/account'), false);
  const profile = consoleNav.find((n) => n.id === 'profile');
  assert.equal(isConsoleNavActive(profile, '/account/files'), false);
  assert.deepEqual(consoleNav.map((n) => n.order), [...consoleNav.map((n) => n.order)].sort((a, b) => a - b));
  assert.equal(new Set(consoleNav.map((n) => n.id)).size, consoleNav.length);
});
