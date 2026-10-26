import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSiteIntegrations, parseSiteIntegrations, SiteIntegrationsUnavailableError } from './src/lib/site-integrations.ts';

const local = { analytics: { enabled: true, google: { enabled: true, measurementId: 'G-SYNTHETIC1' } }, connections: { enabled: false } };
const saved = { analytics: { enabled: false }, connections: { enabled: true,
  adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' } }, revisions: { analytics: 2, connections: 4 } };

test('server source reads the applied public snapshot with the full API prefix and no credentials', async () => {
  let calls = 0;
  const result = await loadSiteIntegrations({ API_URL: 'https://api.example.invalid/prefix/api/' }, local, async (url, options) => {
    calls++; assert.equal(url, 'https://api.example.invalid/prefix/api/site/public/integrations');
    assert.equal(options.cache, 'no-store'); assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ status: 200, result: saved }));
  });
  assert.equal(calls, 1); assert.equal(result.analytics.enabled, false);
  assert.equal(result.connections.adsense.publisherId, saved.connections.adsense.publisherId);
  assert.deepEqual(result.revisions, saved.revisions);
});

test('environment mode is explicit and does not perform a Server request', async () => {
  const result = await loadSiteIntegrations({ SITE_CONFIGURATION_SOURCE: 'environment' }, local, async () => { throw new Error('Unexpected request'); });
  assert.equal(result.analytics.google.measurementId, 'G-SYNTHETIC1');
  assert.deepEqual(result.revisions, { analytics: 0, connections: 0 });
});

test('a Server failure cannot re-enable old local tracking settings', async () => {
  await assert.rejects(loadSiteIntegrations({}, local, async () => new Response('PRIVATE-PROVIDER-DETAIL', { status: 503 })),
    error => error instanceof SiteIntegrationsUnavailableError && !error.message.includes('PRIVATE'));
  await assert.rejects(loadSiteIntegrations({ SITE_CONFIGURATION_SOURCE: 'unexpected' }, local), SiteIntegrationsUnavailableError);
});

test('rejects extra public-contract fields and invalid enabled provider configuration', () => {
  for (const value of [
    { ...saved, environment: { secret: 'PRIVATE' } },
    { ...saved, analytics: { enabled: true, google: { enabled: true, measurementId: 'G-SYNTHETIC1', secret: 'PRIVATE' } } },
    { ...saved, analytics: { enabled: true, google: { enabled: true, measurementId: 'invalid' } } },
    { ...saved, connections: { enabled: 'true' } },
    { ...saved, revisions: { analytics: -1, connections: 0 } },
    { ...saved, revisions: { analytics: '1', connections: 0 } },
  ]) assert.throws(() => parseSiteIntegrations(value), SiteIntegrationsUnavailableError);
});

test('disabled providers never carry identifiers into browser props', () => {
  const result = parseSiteIntegrations({ ...saved, analytics: { enabled: true, google: { enabled: false, measurementId: 'PRIVATE-ACCIDENTAL-VALUE' } },
    connections: { enabled: false, adsense: { enabled: true, publisherId: 'PRIVATE-ACCIDENTAL-VALUE' } } });
  assert.deepEqual(result.analytics.google, { enabled: false });
  assert.deepEqual(result.connections, { enabled: false });
  assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('rejects credentialed API URLs before a request and sanitizes malformed responses', async () => {
  let calls = 0;
  await assert.rejects(loadSiteIntegrations({ API_URL: 'https://synthetic:private@api.example.invalid/api' }, local,
    async () => { calls++; return new Response('{}'); }), SiteIntegrationsUnavailableError);
  assert.equal(calls, 0);
  await assert.rejects(loadSiteIntegrations({}, local, async () => new Response('PRIVATE invalid JSON')),
    error => error instanceof SiteIntegrationsUnavailableError && !error.message.includes('PRIVATE'));
});
