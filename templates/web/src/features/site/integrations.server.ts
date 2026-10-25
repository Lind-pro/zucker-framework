import 'server-only';
import { cache } from 'react';
import { loadSiteIntegrations, disabledSiteIntegrations } from '@/lib/site-integrations';
import { readSiteAnalyticsConfig } from '@/lib/site-analytics-config';
import { readSiteConnectionsConfig } from '@/lib/site-connections-config';

export const readCurrentSiteIntegrations = cache(() => loadSiteIntegrations(process.env, {
  analytics: readSiteAnalyticsConfig(process.env), connections: readSiteConnectionsConfig(process.env),
}));
export const readSafeSiteIntegrations = cache(async () => {
  try { return await readCurrentSiteIntegrations(); }
  catch {
    // A saved disable must never be undone by falling back to stale local tracking configuration.
    console.warn('Public website connection configuration is unavailable; connections are disabled.');
    return disabledSiteIntegrations();
  }
});
