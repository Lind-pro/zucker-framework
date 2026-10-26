import type { SiteConnectionsConfig } from '@zucker-framework/fe-site';

/** Public IDs only. API secrets and user identities never cross into browser configuration. */
export function readSiteConnectionsConfig(environment: Record<string, string | undefined>): SiteConnectionsConfig {
  const enabled = (name: string) => environment[name] === 'true';
  const duration = environment.AFFONSO_COOKIE_DURATION_DAYS;
  return {
    enabled: enabled('SITE_CONNECTIONS_ENABLED'),
    adsense: { enabled: enabled('ADSENSE_ENABLED'), publisherId: environment.ADSENSE_PUBLISHER_ID },
    affonso: { enabled: enabled('AFFONSO_ENABLED'), programId: environment.AFFONSO_PROGRAM_ID,
      cookieDurationDays: duration === undefined || duration === '' ? undefined : /^\d+$/.test(duration) ? Number(duration) : Number.NaN },
    promoteKit: { enabled: enabled('PROMOTEKIT_ENABLED'), programId: environment.PROMOTEKIT_PROGRAM_ID },
    crisp: { enabled: enabled('CRISP_ENABLED'), websiteId: environment.CRISP_WEBSITE_ID },
    tawk: { enabled: enabled('TAWK_ENABLED'), propertyId: environment.TAWK_PROPERTY_ID, widgetId: environment.TAWK_WIDGET_ID },
  };
}
