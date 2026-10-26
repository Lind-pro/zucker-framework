import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSiteAnalyticsConfig } from './src/lib/site-analytics-config.ts';

test('site connections are default-off and only exact explicit switches enable them', () => {
  const config = readSiteAnalyticsConfig({ GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-SYNTHETIC1', SITE_ANALYTICS_ENABLED: 'false', GOOGLE_ANALYTICS_ENABLED: 'TRUE' });
  assert.equal(config.enabled, false);
  assert.equal(config.google.enabled, false);
  for (const name of ['clarity', 'plausible', 'openPanel', 'vercel']) assert.equal(config[name].enabled, false);
});

test('only public connection fields cross into client props', () => {
  const config = readSiteAnalyticsConfig({ SITE_ANALYTICS_ENABLED: 'true', OPENPANEL_ENABLED: 'true', OPENPANEL_CLIENT_ID: 'synthetic-public', OPENPANEL_CLIENT_SECRET: 'synthetic-private', DATABASE_URL: 'synthetic-database', API_URL: 'synthetic-server' });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.openPanel, { enabled: true, clientId: 'synthetic-public', apiUrl: undefined });
  const serialized = JSON.stringify(config);
  assert(!serialized.includes('synthetic-private'));
  assert(!serialized.includes('synthetic-database'));
  assert(!serialized.includes('synthetic-server'));
});
