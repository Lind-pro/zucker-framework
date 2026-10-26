import { resolveSiteAnalytics, type SiteAnalyticsConfig } from '@zucker-framework/fe-analytics/site-analytics';
import { resolveSiteConnections, type SiteConnectionsConfig } from '@zucker-framework/fe-site';

export interface SiteIntegrations {
  analytics: SiteAnalyticsConfig;
  connections: SiteConnectionsConfig;
  revisions: { analytics: number; connections: number };
}
export class SiteIntegrationsUnavailableError extends Error {
  constructor() { super('Public website connections are temporarily unavailable'); }
}
export function disabledSiteIntegrations(): SiteIntegrations {
  return { analytics: { enabled: false }, connections: { enabled: false }, revisions: { analytics: 0, connections: 0 } };
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new SiteIntegrationsUnavailableError();
  return value as Record<string, unknown>;
}
function enabled(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new SiteIntegrationsUnavailableError();
  return value === true;
}
type FieldKind = 'string' | 'number';
function provider<const Shape extends Record<string, FieldKind>>(value: unknown, fields: Shape):
  { enabled: boolean } & { [Key in keyof Shape]?: Shape[Key] extends 'string' ? string : number } {
  const raw = value === undefined ? {} : object(value, ['enabled', ...Object.keys(fields)]);
  const output: Record<string, string | number | boolean> = { enabled: enabled(raw.enabled) };
  // Disabled providers carry no identifiers or URLs into browser props.
  if (output.enabled) for (const [key, kind] of Object.entries(fields)) {
    const field = raw[key]; if (field === undefined) continue;
    if (typeof field !== kind || typeof field === 'string' && (field.length > 4096 || /[\u0000-\u001f\u007f]/.test(field))
      || typeof field === 'number' && !Number.isSafeInteger(field)) throw new SiteIntegrationsUnavailableError();
    output[key] = field as string | number;
  }
  return output as { enabled: boolean } & { [Key in keyof Shape]?: Shape[Key] extends 'string' ? string : number };
}

/** A strict public contract, independent of the application's secret runtime environment. */
export function parseSiteIntegrations(value: unknown): SiteIntegrations {
  const root = object(value, ['analytics', 'connections', 'revisions']);
  const a = object(root.analytics, ['enabled', 'google', 'clarity', 'plausible', 'openPanel', 'vercel']);
  const c = object(root.connections, ['enabled', 'adsense', 'affonso', 'promoteKit', 'crisp', 'tawk']);
  const revision = object(root.revisions, ['analytics', 'connections']);
  for (const field of ['analytics', 'connections']) if (!Number.isSafeInteger(revision[field]) || Number(revision[field]) < 0) throw new SiteIntegrationsUnavailableError();
  const analytics: SiteAnalyticsConfig = enabled(a.enabled) ? { enabled: true,
    google: provider(a.google, { measurementId: 'string' }), clarity: provider(a.clarity, { projectId: 'string' }),
    plausible: provider(a.plausible, { scriptUrl: 'string' }), openPanel: provider(a.openPanel, { clientId: 'string', apiUrl: 'string' }),
    vercel: provider(a.vercel, { scriptPath: 'string' }) } : { enabled: false };
  const connections: SiteConnectionsConfig = enabled(c.enabled) ? { enabled: true,
    adsense: provider(c.adsense, { publisherId: 'string' }), affonso: provider(c.affonso, { programId: 'string', cookieDurationDays: 'number' }),
    promoteKit: provider(c.promoteKit, { programId: 'string' }), crisp: provider(c.crisp, { websiteId: 'string' }),
    tawk: provider(c.tawk, { propertyId: 'string', widgetId: 'string' }) } : { enabled: false };
  if (resolveSiteAnalytics(analytics).issues.length || resolveSiteConnections(connections).issues.length) throw new SiteIntegrationsUnavailableError();
  return { analytics, connections, revisions: { analytics: Number(revision.analytics), connections: Number(revision.connections) } };
}

export async function loadSiteIntegrations(environment: Record<string, string | undefined>,
  environmentConfig: Pick<SiteIntegrations, 'analytics' | 'connections'>, fetcher: typeof fetch = fetch): Promise<SiteIntegrations> {
  const source = environment.SITE_CONFIGURATION_SOURCE ?? 'server';
  if (source === 'environment') return parseSiteIntegrations({ ...environmentConfig, revisions: { analytics: 0, connections: 0 } });
  if (source !== 'server') throw new SiteIntegrationsUnavailableError();
  try {
    const base = new URL(environment.API_URL ?? 'http://localhost:4200/api');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new SiteIntegrationsUnavailableError();
    const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/site/public/integrations`;
    const response = await fetcher(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new SiteIntegrationsUnavailableError();
    const body: unknown = await response.json();
    return parseSiteIntegrations(body && typeof body === 'object' && 'result' in body ? body.result : body);
  } catch { throw new SiteIntegrationsUnavailableError(); }
}
