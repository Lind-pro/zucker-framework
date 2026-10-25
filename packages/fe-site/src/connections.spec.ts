import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAdsTxt, resolveSiteConnections, type SiteConnectionsConfig } from './index';

const all: SiteConnectionsConfig = {
  enabled: true,
  adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' },
  affonso: { enabled: true, programId: 'synthetic-affonso', cookieDurationDays: 30 },
  promoteKit: { enabled: true, programId: 'synthetic-promotekit' },
  crisp: { enabled: true, websiteId: '11111111-2222-4333-8444-555555555555' },
  tawk: { enabled: true, propertyId: 'synthetic-property', widgetId: 'synthetic-widget' },
};

afterEach(() => vi.unstubAllGlobals());

describe('site connection configuration', () => {
  it('requires explicit global and individual opt-in before validation or output', () => {
    expect(resolveSiteConnections()).toEqual({ connections: [], issues: [] });
    expect(resolveSiteConnections({ ...all, enabled: false })).toEqual({ connections: [], issues: [] });
    expect(resolveSiteConnections({ ...all, enabled: undefined })).toEqual({ connections: [], issues: [] });
    expect(resolveSiteConnections({ enabled: true, adsense: { publisherId: 'invalid' }, crisp: { enabled: false } }))
      .toEqual({ connections: [], issues: [] });
  });

  it('resolves without browser globals or external requests', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expect(resolveSiteConnections(all).connections).toHaveLength(5);
    expect(buildAdsTxt(all)).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses fixed official endpoints and public provider attributes', () => {
    const result = resolveSiteConnections(all);
    expect(result.issues).toEqual([]);
    const scripts = result.connections.flatMap(connection => connection.scripts);
    expect(scripts.filter(script => script.src).map(script => ({ src: script.src, attributes: script.attributes, crossOrigin: script.crossOrigin })))
      .toEqual([
        { src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456', attributes: undefined, crossOrigin: 'anonymous' },
        { src: 'https://cdn.affonso.io/js/pixel.min.js', attributes: { 'data-affonso': 'synthetic-affonso', 'data-cookie_duration': '30' }, crossOrigin: undefined },
        { src: 'https://cdn.promotekit.com/promotekit.js', attributes: { 'data-promotekit': 'synthetic-promotekit' }, crossOrigin: undefined },
        { src: 'https://client.crisp.chat/l.js', attributes: undefined, crossOrigin: undefined },
        { src: 'https://embed.tawk.to/synthetic-property/synthetic-widget', attributes: undefined, crossOrigin: 'anonymous' },
      ]);
    expect(new Set(scripts.map(script => script.id)).size).toBe(scripts.length);
    expect(resolveSiteConnections(all)).toEqual(result);
  });

  it('isolates invalid enabled providers without leaking their supplied values', () => {
    const result = resolveSiteConnections({
      ...all,
      adsense: { enabled: true, publisherId: '</script><secret>' },
      affonso: { enabled: true, programId: 'synthetic-affonso', cookieDurationDays: 0 },
      crisp: { enabled: true, websiteId: '</script><secret>' },
    });
    expect(result.connections.map(connection => connection.provider)).toEqual(['promotekit', 'tawk']);
    expect(result.issues.map(issue => issue.provider)).toEqual(['adsense', 'affonso', 'crisp']);
    expect(JSON.stringify(result.issues)).not.toContain('<secret>');
  });

  it.each([
    { adsense: { enabled: true, publisherId: 'ca-pub-123' } },
    { affonso: { enabled: true, programId: 'https://tracker.example.test', cookieDurationDays: 30 } },
    { promoteKit: { enabled: true, programId: 'synthetic?redirect=other' } },
    { crisp: { enabled: true, websiteId: 'not-a-uuid' } },
    { tawk: { enabled: true, propertyId: '../other', widgetId: 'synthetic-widget' } },
    { tawk: { enabled: true, propertyId: 'synthetic-property', widgetId: 'synthetic/other' } },
  ])('rejects malformed or URL-shaped identifiers: %j', config => {
    const result = resolveSiteConnections({ enabled: true, ...config });
    expect(result.connections).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it.each([undefined, 0, -1, 366, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid Affonso cookie duration %s', cookieDurationDays => {
    const result = resolveSiteConnections({ enabled: true, affonso: { enabled: true, programId: 'synthetic', cookieDurationDays } });
    expect(result.connections).toEqual([]);
    expect(result.issues[0]?.provider).toBe('affonso');
  });

  it.each([1, 365])('accepts boundary Affonso cookie duration %s', cookieDurationDays => {
    const result = resolveSiteConnections({ enabled: true, affonso: { enabled: true, programId: 'synthetic', cookieDurationDays } });
    expect(result.issues).toEqual([]);
    expect(result.connections[0]?.scripts[0]?.attributes?.['data-cookie_duration']).toBe(String(cookieDurationDays));
  });

  it('initializes support globals once while preserving existing queues and API state', () => {
    const crispQueue = [['do', 'synthetic-operation']];
    const tawkApi = { synthetic: true };
    const browser: Record<string, unknown> = { $crisp: crispQueue, Tawk_API: tawkApi };
    const initializers = resolveSiteConnections(all).connections.flatMap(connection => connection.scripts).filter(script => script.content);
    const run = () => { for (const script of initializers) new Function('window', script.content!)(browser); };
    run();
    const tawkStart = browser.Tawk_LoadStart;
    run();
    expect(browser.$crisp).toBe(crispQueue);
    expect(browser.CRISP_WEBSITE_ID).toBe('11111111-2222-4333-8444-555555555555');
    expect(browser.Tawk_API).toBe(tawkApi);
    expect(browser.Tawk_LoadStart).toBe(tawkStart);
    expect(tawkStart).toBeInstanceOf(Date);
  });
});

describe('ads.txt declaration', () => {
  it.each([
    undefined,
    {},
    { adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' } },
    { enabled: true, adsense: { publisherId: 'ca-pub-1234567890123456' } },
    { enabled: true, adsense: { enabled: false, publisherId: 'ca-pub-1234567890123456' } },
    { enabled: true, adsense: { enabled: true, publisherId: 'pub-1234567890123456' } },
    { enabled: true, adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456\nother.com, other' } },
  ])('emits no declaration without a valid enabled publisher: %j', config => {
    expect(buildAdsTxt(config)).toBeNull();
  });

  it('emits a single official seller line independently of unrelated invalid providers', () => {
    expect(buildAdsTxt({ ...all, crisp: { enabled: true, websiteId: 'invalid' } }))
      .toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  });
});
