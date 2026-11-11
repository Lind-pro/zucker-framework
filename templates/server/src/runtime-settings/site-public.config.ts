import { BadRequestException } from '@nestjs/common';
import { resolveSiteAnalytics, type SiteAnalyticsConfig } from '@zucker-framework/fe-analytics/site-analytics';
import { buildAdsTxt, resolveSiteConnections, type SiteConnectionsConfig } from '@zucker-framework/fe-site';

/** Explicit public field mapping; never spread process or provider environment into a response. */
export function siteAnalyticsConfig(environment: Readonly<NodeJS.ProcessEnv>): SiteAnalyticsConfig {
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
export function siteConnectionsConfig(environment: Readonly<NodeJS.ProcessEnv>): SiteConnectionsConfig {
  const enabled = (name: string) => environment[name] === 'true', duration = environment.AFFONSO_COOKIE_DURATION_DAYS;
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
export function validatePublicAnalytics(config: SiteAnalyticsConfig): void {
  if (resolveSiteAnalytics(config).issues.length) throw new BadRequestException('Invalid public analytics configuration');
}
export function validatePublicConnections(config: SiteConnectionsConfig): void {
  if (resolveSiteConnections(config).issues.length || config.enabled && config.adsense?.enabled && !buildAdsTxt(config)) throw new BadRequestException('Invalid public website connection configuration');
}
/** Disabled connections expose no identifiers or URLs, including accidentally entered private data. */
export function appliedPublicSiteConfiguration(environment: Readonly<NodeJS.ProcessEnv>): { analytics: SiteAnalyticsConfig; connections: SiteConnectionsConfig } {
  const analytics = siteAnalyticsConfig(environment), connections = siteConnectionsConfig(environment);
  validatePublicAnalytics(analytics); validatePublicConnections(connections);
  return {
    analytics: analytics.enabled ? { enabled: true,
      google: analytics.google?.enabled ? analytics.google : { enabled: false },
      clarity: analytics.clarity?.enabled ? analytics.clarity : { enabled: false },
      plausible: analytics.plausible?.enabled ? analytics.plausible : { enabled: false },
      openPanel: analytics.openPanel?.enabled ? analytics.openPanel : { enabled: false },
      vercel: analytics.vercel?.enabled ? analytics.vercel : { enabled: false },
    } : { enabled: false },
    connections: connections.enabled ? { enabled: true,
      adsense: connections.adsense?.enabled ? connections.adsense : { enabled: false },
      affonso: connections.affonso?.enabled ? connections.affonso : { enabled: false },
      promoteKit: connections.promoteKit?.enabled ? connections.promoteKit : { enabled: false },
      crisp: connections.crisp?.enabled ? connections.crisp : { enabled: false },
      tawk: connections.tawk?.enabled ? connections.tawk : { enabled: false },
    } : { enabled: false },
  };
}

/** Settings host projection behind `GET /site/public/integrations` and `ConnectionSettingsService.publicIntegrations()`. */
export function publicIntegrationsProjection(environment: Readonly<NodeJS.ProcessEnv>, revisions: ReadonlyMap<string, number>) {
  return { ...appliedPublicSiteConfiguration(environment), revisions: { analytics: revisions.get('web-analytics') ?? 0, connections: revisions.get('web-connections') ?? 0 } };
}
