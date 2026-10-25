/** Optional provider scripts. This entry is pure and has no browser or transport side effects. */
export type SiteAnalyticsProvider = 'google' | 'clarity' | 'plausible' | 'openPanel' | 'vercel';
interface EnabledProvider { enabled?: boolean }
export interface SiteAnalyticsConfig {
  /** Both this switch and an individual provider's switch must be explicitly true. */
  enabled?: boolean;
  google?: EnabledProvider & { measurementId?: string };
  clarity?: EnabledProvider & { projectId?: string };
  /** Use the site's current installation URL, not the retired shared data-domain snippet. */
  plausible?: EnabledProvider & { scriptUrl?: string };
  openPanel?: EnabledProvider & { clientId?: string; apiUrl?: string };
  /** Copy the same-origin script path from this Vercel project's installation settings. */
  vercel?: EnabledProvider & { scriptPath?: string };
}
export interface SiteAnalyticsScript {
  provider: SiteAnalyticsProvider;
  id: string;
  src?: string;
  content?: string;
}
export interface SiteAnalyticsIssue {
  provider: SiteAnalyticsProvider;
  message: string;
}
export interface SiteAnalyticsPlan {
  scripts: SiteAnalyticsScript[];
  issues: SiteAnalyticsIssue[];
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function identifier(value: string | undefined, pattern: RegExp, message: string): string {
  const result = value?.trim();
  if (!result || !pattern.test(result)) throw new Error(message);
  return result;
}
function scriptUrl(value: string | undefined, sameOriginOnly = false): string {
  if (!value || value !== value.trim() || /[\\\s\u0000-\u001f]/.test(value)) throw new Error('A valid script URL is required.');
  const relative = value.startsWith('/') && !value.startsWith('//');
  if (!relative && !value.startsWith('https://')) throw new Error('Use an HTTPS or same-origin script URL.');
  const parsed = new URL(value, 'https://site.invalid');
  if ((!relative && (sameOriginOnly || parsed.protocol !== 'https:')) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(sameOriginOnly ? 'Use the project’s same-origin script path.' : 'Use an HTTPS or same-origin script URL without credentials or fragments.');
  }
  return value;
}
function bootstrap(provider: SiteAnalyticsProvider, content: string): SiteAnalyticsScript {
  // The browser guard also prevents re-initialization when a host remounts its script wrapper.
  const marker = scriptJson(`__zucker_site_analytics_${provider}`);
  return { provider, id: `zucker-analytics-${provider}-init`, content: `(function(){if(window[${marker}])return;window[${marker}]=true;${content}})();` };
}
function loader(provider: SiteAnalyticsProvider, src: string): SiteAnalyticsScript {
  return { provider, id: `zucker-analytics-${provider}-script`, src };
}

/**
 * Resolve only explicitly enabled providers, reporting invalid providers independently.
 * Hosts decide consent/eligibility before mounting and apply config changes on a full page load.
 * Removing a script element cannot unload an SDK that has already executed.
 */
export function resolveSiteAnalytics(config: SiteAnalyticsConfig = {}): SiteAnalyticsPlan {
  const plan: SiteAnalyticsPlan = { scripts: [], issues: [] };
  if (config.enabled !== true) return plan;
  const add = (provider: SiteAnalyticsProvider, enabled: boolean | undefined, build: () => SiteAnalyticsScript[]) => {
    if (enabled !== true) return;
    try { plan.scripts.push(...build()); }
    catch (error) { plan.issues.push({ provider, message: error instanceof Error ? error.message : 'Invalid provider configuration.' }); }
  };
  add('google', config.google?.enabled, () => {
    const id = identifier(config.google?.measurementId, /^G-[A-Z0-9]{1,64}$/, 'A GA4 measurement ID beginning with G- is required.');
    return [
      bootstrap('google', `window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};window.gtag('js',new Date());window.gtag('config',${scriptJson(id)});`),
      loader('google', `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`),
    ];
  });
  add('clarity', config.clarity?.enabled, () => {
    const id = identifier(config.clarity?.projectId, /^[a-zA-Z0-9]{1,64}$/, 'An alphanumeric Clarity project ID is required.');
    return [
      bootstrap('clarity', "window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments);};"),
      loader('clarity', `https://www.clarity.ms/tag/${encodeURIComponent(id)}`),
    ];
  });
  add('plausible', config.plausible?.enabled, () => [
    bootstrap('plausible', "window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments);};window.plausible.init=window.plausible.init||function(options){window.plausible.o=options||{};};window.plausible.init({autoCapturePageviews:true});"),
    loader('plausible', scriptUrl(config.plausible?.scriptUrl)),
  ]);
  add('openPanel', config.openPanel?.enabled, () => {
    const clientId = identifier(config.openPanel?.clientId, /^[a-zA-Z0-9_-]{1,128}$/, 'An OpenPanel public client ID is required.');
    const options = { clientId, ...(config.openPanel?.apiUrl ? { apiUrl: scriptUrl(config.openPanel.apiUrl) } : {}), trackScreenViews: true, trackOutgoingLinks: false, trackAttributes: false, sessionReplay: { enabled: false } };
    return [
      bootstrap('openPanel', `window.op=window.op||function(){(window.op.q=window.op.q||[]).push(Array.from(arguments));};window.op('init',${scriptJson(options)});`),
      loader('openPanel', 'https://openpanel.dev/op1.js'),
    ];
  });
  add('vercel', config.vercel?.enabled, () => [
    bootstrap('vercel', "window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};"),
    loader('vercel', scriptUrl(config.vercel?.scriptPath, true)),
  ]);
  return plan;
}
