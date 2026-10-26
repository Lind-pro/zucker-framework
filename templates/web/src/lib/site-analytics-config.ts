import type { SiteAnalyticsConfig } from '@zucker-framework/fe-analytics/site-analytics';

/** Only public connection settings cross the server/client boundary. */
export function readSiteAnalyticsConfig(environment: Record<string, string | undefined>): SiteAnalyticsConfig {
  const enabled = (name: string) => environment[name] === 'true';
  return {
    enabled: enabled('SITE_ANALYTICS_ENABLED'),
    google: { enabled: enabled('GOOGLE_ANALYTICS_ENABLED'), measurementId: environment.GOOGLE_ANALYTICS_MEASUREMENT_ID },
    clarity: { enabled: enabled('CLARITY_ENABLED'), projectId: environment.CLARITY_PROJECT_ID },
    plausible: { enabled: enabled('PLAUSIBLE_ENABLED'), scriptUrl: environment.PLAUSIBLE_SCRIPT_URL },
    openPanel: { enabled: enabled('OPENPANEL_ENABLED'), clientId: environment.OPENPANEL_CLIENT_ID, apiUrl: environment.OPENPANEL_API_URL },
    vercel: { enabled: enabled('VERCEL_ANALYTICS_ENABLED'), scriptPath: environment.VERCEL_ANALYTICS_SCRIPT_PATH },
  };
}
