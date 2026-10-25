import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSiteConnectionsConfig } from './src/lib/site-connections-config.ts';
import { buildAdsTxt, resolveSiteConnections } from '@zucker-framework/fe-site';

test('site connections require exact explicit global and per-provider switches', () => {
  const config = readSiteConnectionsConfig({ ADSENSE_PUBLISHER_ID: 'ca-pub-1234567890123456', ADSENSE_ENABLED: 'TRUE' });
  assert.equal(config.enabled, false);
  for (const name of ['adsense', 'affonso', 'promoteKit', 'crisp', 'tawk']) assert.equal(config[name].enabled, false);
  assert.deepEqual(resolveSiteConnections(config), { connections: [], issues: [] });
  assert.equal(buildAdsTxt(config), null);
});

test('only public fields cross into client props and invalid duration is not defaulted', () => {
  const config = readSiteConnectionsConfig({ SITE_CONNECTIONS_ENABLED: 'true', AFFONSO_ENABLED: 'true',
    AFFONSO_PROGRAM_ID: 'synthetic-program', AFFONSO_COOKIE_DURATION_DAYS: '30days', AFFONSO_API_KEY: 'synthetic-private',
    CRISP_TOKEN: 'synthetic-private', USER_EMAIL: 'synthetic@example.test', DATABASE_URL: 'synthetic-database' });
  assert(Number.isNaN(config.affonso.cookieDurationDays));
  assert.equal(resolveSiteConnections(config).connections.length, 0);
  assert.equal(resolveSiteConnections(config).issues.length, 1);
  const serialized = JSON.stringify(config);
  for (const secret of ['synthetic-private', 'synthetic@example.test', 'synthetic-database']) assert(!serialized.includes(secret));
});

test('a valid enabled public publisher produces the root ads.txt declaration', () => {
  const config = readSiteConnectionsConfig({ SITE_CONNECTIONS_ENABLED: 'true', ADSENSE_ENABLED: 'true', ADSENSE_PUBLISHER_ID: 'ca-pub-1234567890123456' });
  assert.equal(buildAdsTxt(config), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
});
