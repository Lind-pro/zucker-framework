export type SiteConnectionProvider = 'adsense' | 'affonso' | 'promotekit' | 'crisp' | 'tawk';
interface OptionalConnection { enabled?: boolean }
export interface SiteConnectionsConfig {
  /** Both this switch and the individual connection must be explicitly enabled. */
  enabled?: boolean;
  adsense?: OptionalConnection & { publisherId?: string };
  affonso?: OptionalConnection & { programId?: string; cookieDurationDays?: number };
  promoteKit?: OptionalConnection & { programId?: string };
  crisp?: OptionalConnection & { websiteId?: string };
  tawk?: OptionalConnection & { propertyId?: string; widgetId?: string };
}
export interface SiteConnectionScript {
  id: string;
  src?: string;
  content?: string;
  attributes?: Record<string, string>;
  crossOrigin?: 'anonymous';
}
export interface SiteConnectionIssue { provider: SiteConnectionProvider; message: string }
export interface SiteConnectionPlan {
  connections: Array<{ provider: SiteConnectionProvider; scripts: SiteConnectionScript[] }>;
  issues: SiteConnectionIssue[];
}

function identifier(value: string | undefined, pattern: RegExp, message: string): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(candidate)) throw new Error(message);
  return candidate;
}
function json(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function loader(provider: SiteConnectionProvider, src: string, attributes?: Record<string, string>, crossOrigin?: 'anonymous'): SiteConnectionScript {
  return { id: `zucker-site-${provider}-script`, src, ...(attributes ? { attributes } : {}), ...(crossOrigin ? { crossOrigin } : {}) };
}
function bootstrap(provider: SiteConnectionProvider, content: string): SiteConnectionScript {
  const key = json(`__zucker_site_connection_${provider}`);
  return { id: `zucker-site-${provider}-init`, content: `(function(){if(window[${key}])return;window[${key}]=true;${content}})();` };
}
function publisherId(config: SiteConnectionsConfig): string {
  return identifier(config.adsense?.publisherId, /^ca-pub-\d{16}$/, 'An AdSense ca-pub- publisher ID with 16 digits is required.');
}

/** Pure configuration resolution. No scripts run and no cookies/browser globals are accessed. */
export function resolveSiteConnections(config: SiteConnectionsConfig = {}): SiteConnectionPlan {
  const plan: SiteConnectionPlan = { connections: [], issues: [] };
  if (config.enabled !== true) return plan;
  const add = (provider: SiteConnectionProvider, enabled: boolean | undefined, build: () => SiteConnectionScript[]) => {
    if (enabled !== true) return;
    try { plan.connections.push({ provider, scripts: build() }); }
    catch (error) { plan.issues.push({ provider, message: error instanceof Error ? error.message : 'Invalid connection configuration.' }); }
  };
  add('adsense', config.adsense?.enabled, () => [loader('adsense',
    `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId(config)}`, undefined, 'anonymous')]);
  add('affonso', config.affonso?.enabled, () => {
    const id = identifier(config.affonso?.programId, /^[a-zA-Z0-9_-]{1,128}$/, 'An Affonso public program ID is required.');
    const days = config.affonso?.cookieDurationDays;
    if (!Number.isSafeInteger(days) || days === undefined || days < 1 || days > 365) throw new Error('Affonso cookie duration must be an integer from 1 to 365 days.');
    return [loader('affonso', 'https://cdn.affonso.io/js/pixel.min.js', { 'data-affonso': id, 'data-cookie_duration': String(days) })];
  });
  add('promotekit', config.promoteKit?.enabled, () => [loader('promotekit', 'https://cdn.promotekit.com/promotekit.js', {
    'data-promotekit': identifier(config.promoteKit?.programId, /^[a-zA-Z0-9_-]{1,128}$/, 'A PromoteKit public program ID is required.'),
  })]);
  add('crisp', config.crisp?.enabled, () => {
    const id = identifier(config.crisp?.websiteId, /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/, 'A Crisp Website ID in UUID format is required.');
    return [bootstrap('crisp', `window.$crisp=window.$crisp||[];window.CRISP_WEBSITE_ID=${json(id)};`),
      loader('crisp', 'https://client.crisp.chat/l.js')];
  });
  add('tawk', config.tawk?.enabled, () => {
    const property = identifier(config.tawk?.propertyId, /^[a-zA-Z0-9_-]{1,128}$/, 'A tawk.to property ID is required.');
    const widget = identifier(config.tawk?.widgetId, /^[a-zA-Z0-9_-]{1,128}$/, 'A tawk.to widget ID is required.');
    return [bootstrap('tawk', 'window.Tawk_API=window.Tawk_API||{};window.Tawk_LoadStart=new Date();'),
      loader('tawk', `https://embed.tawk.to/${encodeURIComponent(property)}/${encodeURIComponent(widget)}`, undefined, 'anonymous')];
  });
  return plan;
}

/** Only an enabled, valid public AdSense seller declaration is emitted. */
export function buildAdsTxt(config: SiteConnectionsConfig = {}): string | null {
  if (config.enabled !== true || config.adsense?.enabled !== true) return null;
  try { return `google.com, ${publisherId(config).slice(3)}, DIRECT, f08c47fec0942fa0\n`; }
  catch { return null; }
}
