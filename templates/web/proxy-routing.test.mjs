import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source uses extensionless relative imports and the `@/` alias (bundler resolution); map both to .ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('@/') ? new URL(`./src/${specifier.slice(2)}`, import.meta.url).href : specifier;
    if ((relative.startsWith('.') || relative.startsWith('file:')) && !/\.[cm]?[jt]sx?$/.test(relative) && context.parentURL) {
      const url = new URL(`${relative}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(relative, context);
  },
});

const { NextRequest } = await import('next/server.js');
const { default: proxy } = await import('./src/proxy.ts');
const { DEFAULT_LOCALE } = await import('./src/lib/site/locales.ts');
const other = DEFAULT_LOCALE === 'en' ? 'zh' : 'en';

// Next hands the proxy an absolute URL built from the bound address (`next start -H …`/HOSTNAME and
// port), never from the client's Host header; a reverse proxy may send any Host. (NextRequest itself
// turns 127.x/[::1] into localhost, which is why next.config sets skipProxyUrlNormalize: see below.)
const bound = 'http://10.0.0.5:4391';
const request = (path, host = 'www.example.invalid') => new NextRequest(`${bound}${path}`, { headers: { host } });

test('unprefixed default-locale paths rewrite internally on the request origin, whatever the Host', () => {
  for (const host of ['www.example.invalid', '127.0.0.1:4391', 'localhost:4202']) {
    const response = proxy(request('/pricing?a=1', host));
    assert.equal(response.headers.get('location'), null);
    const rewrite = new URL(response.headers.get('x-middleware-rewrite'));
    // Same origin as request.url, so Next keeps the rewrite internal instead of proxying it (which
    // would re-enter the proxy as /<default>/pricing and redirect back to /pricing forever).
    assert.equal(rewrite.origin, bound);
    assert.equal(rewrite.pathname, `/${DEFAULT_LOCALE}/pricing`);
    assert.equal(rewrite.search, '?a=1');
  }
});

test('a default-locale prefix redirects once to the unprefixed path; other locales pass through', () => {
  const redirect = proxy(request(`/${DEFAULT_LOCALE}/pricing`));
  assert.equal(redirect.status, 307);
  assert.equal(new URL(redirect.headers.get('location'), bound).pathname, '/pricing');
  const passthrough = proxy(request(`/${other}/pricing`));
  assert.equal(passthrough.headers.get('location'), null);
  assert.equal(passthrough.headers.get('x-middleware-rewrite'), null);
});

// Without it Next rebuilds the proxy URL through NextURL, which maps 127.x/[::1] to localhost. With
// `next start -H 127.0.0.1` (or HOSTNAME=127.0.0.1 in standalone) the as-needed rewrite then targets
// localhost, Next treats it as an external rewrite and proxies /en/pricing back into this server,
// which redirects to /pricing: an endless 307 loop on every unprefixed path.
test('next.config gives the proxy the routed URL so a loopback bind keeps rewrites internal', async () => {
  const loaded = await import('next/dist/server/config.js');
  const loadConfig = loaded.default.default ?? loaded.default;
  const config = await loadConfig('phase-production-server', fileURLToPath(new URL('.', import.meta.url)), { silent: true });
  assert.equal(config.skipProxyUrlNormalize, true);
});

test('protected paths redirect to login without Next internal query parameters', () => {
  const response = proxy(request('/dashboard?tab=a&_rsc=abc123'));
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin, bound);
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('redirect'), '/dashboard?tab=a');
});
