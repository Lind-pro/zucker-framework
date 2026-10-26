import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSiteAnalytics, type SiteAnalyticsConfig } from './site-analytics';

// Execute only locally generated queue setup against an isolated window object.
const runBootstrap = (source: string, context: { window: Record<string, unknown> }) => new Function('window', source)(context.window);

const all: SiteAnalyticsConfig = {
  enabled: true,
  google: { enabled: true, measurementId: 'G-SYNTHETIC1' },
  clarity: { enabled: true, projectId: 'synthetic1' },
  plausible: { enabled: true, scriptUrl: 'https://analytics.example.test/js/pa-synthetic.js' },
  openPanel: { enabled: true, clientId: 'synthetic-client', apiUrl: 'https://events.example.test' },
  vercel: { enabled: true, scriptPath: '/synthetic-insights/script.js' },
};

afterEach(() => vi.unstubAllGlobals());

describe('optional site analytics', () => {
  it('is off by default and requires both global and provider opt-in', () => {
    expect(resolveSiteAnalytics()).toEqual({ scripts: [], issues: [] });
    expect(resolveSiteAnalytics({ ...all, enabled: false })).toEqual({ scripts: [], issues: [] });
    expect(resolveSiteAnalytics({ enabled: true, google: { measurementId: 'G-SYNTHETIC1' }, clarity: { enabled: false, projectId: 'bad<script>' } })).toEqual({ scripts: [], issues: [] });
  });

  it('resolves without touching the browser, sending events, or attaching unload listeners', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expect(resolveSiteAnalytics(all).scripts).toHaveLength(10);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the documented current installation endpoints and deterministic host IDs', () => {
    const { scripts, issues } = resolveSiteAnalytics(all);
    expect(issues).toEqual([]);
    expect(new Set(scripts.map(script => script.id)).size).toBe(10);
    expect(scripts.filter(script => script.src).map(script => script.src)).toEqual([
      'https://www.googletagmanager.com/gtag/js?id=G-SYNTHETIC1',
      'https://www.clarity.ms/tag/synthetic1',
      'https://analytics.example.test/js/pa-synthetic.js',
      'https://openpanel.dev/op1.js',
      '/synthetic-insights/script.js',
    ]);
    expect(resolveSiteAnalytics(all)).toEqual({ scripts, issues });
  });

  it('queues one initialization per document without adding manual pageview duplicates', () => {
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    const scripts = resolveSiteAnalytics(all).scripts;
    for (let mount = 0; mount < 2; mount++) {
      for (const script of scripts) if (script.content) runBootstrap(script.content, sandbox);
    }
    const layer = sandbox.window.dataLayer as IArguments[];
    expect(layer).toHaveLength(2);
    expect(layer[0][0]).toBe('js');
    expect(Object.prototype.toString.call(layer[0][1])).toBe('[object Date]');
    expect(Array.from(layer[1])).toEqual(['config', 'G-SYNTHETIC1']);
    const plausible = sandbox.window.plausible as { o: unknown };
    expect(plausible.o).toEqual({ autoCapturePageviews: true });
    const openPanel = sandbox.window.op as { q: unknown[][] };
    expect(openPanel.q).toEqual([['init', {
      clientId: 'synthetic-client', apiUrl: 'https://events.example.test', trackScreenViews: true,
      trackOutgoingLinks: false, trackAttributes: false, sessionReplay: { enabled: false },
    }]]);
    expect(typeof sandbox.window.clarity).toBe('function');
    expect(typeof sandbox.window.va).toBe('function');
    expect(scripts.every(script => !script.content?.includes("'identify'"))).toBe(true);
  });

  it('isolates a malformed enabled provider while leaving valid connections available', () => {
    const result = resolveSiteAnalytics({ ...all, google: { enabled: true, measurementId: 'G-</script>' }, plausible: { enabled: true } });
    expect(result.issues.map(issue => issue.provider)).toEqual(['google', 'plausible']);
    expect(result.scripts.map(script => script.provider)).toEqual(['clarity', 'clarity', 'openPanel', 'openPanel', 'vercel', 'vercel']);
    expect(JSON.stringify(result.issues)).not.toContain('</script>');
  });

  it.each(['javascript:alert(1)', 'data:text/javascript,alert(1)', '//other.example.test/script.js', 'script.js', 'http://other.example.test/script.js', 'https://user:secret@example.test/script.js', '/script.js#fragment', '/\\evil.example.test/script.js'])('rejects unsafe or ambiguous script URL %s', scriptUrl => {
    const result = resolveSiteAnalytics({ enabled: true, plausible: { enabled: true, scriptUrl } });
    expect(result.scripts).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it('requires a same-origin Vercel project script and permits configured same-origin Plausible proxies', () => {
    const result = resolveSiteAnalytics({ enabled: true, plausible: { enabled: true, scriptUrl: '/metrics/script.js' }, vercel: { enabled: true, scriptPath: 'https://another.example.test/script.js' } });
    expect(result.scripts.find(script => script.src)?.src).toBe('/metrics/script.js');
    expect(result.issues.map(issue => issue.provider)).toEqual(['vercel']);
  });

  it('keeps configured URL data from breaking out of a bootstrap script', () => {
    const result = resolveSiteAnalytics({ enabled: true, openPanel: { enabled: true, clientId: 'synthetic', apiUrl: 'https://events.example.test/?hint=</script>' } });
    expect(result.issues).toEqual([]);
    const content = result.scripts[0].content!;
    expect(content).not.toContain('</script>');
    expect(content).toContain('\\u003c');
    const sandbox = { window: {} as Record<string, unknown> };
    expect(() => runBootstrap(content, sandbox)).not.toThrow();
  });
});
