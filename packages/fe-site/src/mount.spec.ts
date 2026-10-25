import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSiteConnections, resolveSiteConnections, type SiteConnectionsConfig } from './index';

const all: SiteConnectionsConfig = {
  enabled: true,
  adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' },
  affonso: { enabled: true, programId: 'synthetic-affonso', cookieDurationDays: 30 },
  promoteKit: { enabled: true, programId: 'synthetic-promotekit' },
  crisp: { enabled: true, websiteId: '11111111-2222-4333-8444-555555555555' },
  tawk: { enabled: true, propertyId: 'synthetic-property', widgetId: 'synthetic-widget' },
};

const freshDocument = () => document.implementation.createHTMLDocument('synthetic');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit site connection mounting', () => {
  it('imports and resolves without touching a document or making requests', async () => {
    vi.resetModules();
    const createElement = vi.fn();
    const fetcher = vi.fn();
    vi.stubGlobal('document', { createElement });
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('fetch', fetcher);
    const api = await import('./index');
    expect(api.resolveSiteConnections(all).connections).toHaveLength(5);
    expect(createElement).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('mounts the resolved scripts only into the explicitly supplied document', () => {
    const target = freshDocument();
    const result = mountSiteConnections(all, { document: target, nonce: 'synthetic-nonce' });
    const planned = resolveSiteConnections(all).connections.flatMap(connection => connection.scripts);
    const actual = Array.from(target.head.querySelectorAll('script'));
    expect(result).toEqual({ mounted: ['adsense', 'affonso', 'promotekit', 'crisp', 'tawk'], issues: [] });
    expect(actual.map(script => script.id)).toEqual(planned.map(script => script.id));
    for (const [index, script] of actual.entries()) {
      const specification = planned[index]!;
      expect(script.nonce).toBe('synthetic-nonce');
      if (specification.src) {
        expect(script.src).toBe(specification.src);
        expect(script.async).toBe(true);
        expect(script.defer).toBe(true);
      } else expect(script.textContent).toBe(specification.content);
      for (const [name, value] of Object.entries(specification.attributes ?? {})) expect(script.getAttribute(name)).toBe(value);
      if (specification.crossOrigin) expect(script.crossOrigin).toBe(specification.crossOrigin);
    }
    expect(document.getElementById('zucker-site-adsense-script')).toBeNull();
  });

  it('does not inspect or mutate the document when globally disabled', () => {
    const target = freshDocument();
    const create = vi.spyOn(target, 'createElement');
    const find = vi.spyOn(target, 'getElementById');
    expect(mountSiteConnections({ ...all, enabled: false }, { document: target })).toEqual({ mounted: [], issues: [] });
    expect(create).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('deduplicates repeated calls per document while allowing a fresh document', () => {
    const first = freshDocument();
    mountSiteConnections(all, { document: first });
    const scripts = Array.from(first.scripts);
    expect(mountSiteConnections(all, { document: first, nonce: 'different-nonce' })).toEqual({ mounted: [], issues: [] });
    expect(Array.from(first.scripts)).toEqual(scripts);
    expect(mountSiteConnections(all, { document: freshDocument() }).mounted).toHaveLength(5);
  });

  it('reports changed configuration and leaves the existing SDK untouched', () => {
    const target = freshDocument();
    mountSiteConnections(all, { document: target });
    const previous = Array.from(target.scripts);
    const onIssue = vi.fn();
    const result = mountSiteConnections({ ...all, promoteKit: { enabled: true, programId: 'different-program' } }, { document: target, onIssue });
    expect(result.mounted).toEqual([]);
    expect(result.issues).toEqual([{ provider: 'promotekit', message: expect.stringContaining('reload') }]);
    expect(onIssue).toHaveBeenCalledWith(result.issues[0]);
    expect(Array.from(target.scripts)).toEqual(previous);
  });

  it('rejects an incomplete or foreign script collision instead of filling or replacing it', () => {
    const target = freshDocument();
    const foreign = target.createElement('script');
    foreign.id = 'zucker-site-crisp-init';
    target.head.appendChild(foreign);
    const result = mountSiteConnections({ enabled: true, crisp: all.crisp }, { document: target });
    expect(result.mounted).toEqual([]);
    expect(result.issues[0]?.provider).toBe('crisp');
    expect(Array.from(target.scripts)).toEqual([foreign]);
  });

  it('reports invalid configurations and still mounts unrelated valid providers', () => {
    const onIssue = vi.fn();
    const target = freshDocument();
    const result = mountSiteConnections({ enabled: true, adsense: { enabled: true, publisherId: 'invalid' }, promoteKit: all.promoteKit }, { document: target, onIssue });
    expect(result.mounted).toEqual(['promotekit']);
    expect(result.issues[0]?.provider).toBe('adsense');
    expect(onIssue).toHaveBeenCalledTimes(1);
    expect(onIssue).toHaveBeenCalledWith(result.issues[0]);
    expect(Array.from(target.scripts).map(script => script.id)).toEqual(['zucker-site-promotekit-script']);
  });

  it('reports a script error once and does not retry the external request on later calls', () => {
    const target = freshDocument();
    const onIssue = vi.fn();
    const config = { enabled: true, promoteKit: all.promoteKit };
    const first = mountSiteConnections(config, { document: target, onIssue });
    const script = target.getElementById('zucker-site-promotekit-script')!;
    script.dispatchEvent(new Event('error'));
    script.dispatchEvent(new Event('error'));
    expect(first.issues).toEqual([{ provider: 'promotekit', message: 'Connection script failed to load.' }]);
    expect(onIssue).toHaveBeenCalledTimes(1);
    expect(mountSiteConnections(config, { document: target }).mounted).toEqual([]);
    expect(target.scripts).toHaveLength(1);
  });

  it.each([false, true])('does not reload an attempted SDK after host cleanup removes its node (load error: %s)', failed => {
    const target = freshDocument();
    const config = { enabled: true, promoteKit: all.promoteKit };
    mountSiteConnections(config, { document: target });
    const script = target.getElementById('zucker-site-promotekit-script')!;
    if (failed) script.dispatchEvent(new Event('error'));
    script.remove();
    expect(mountSiteConnections(config, { document: target }).mounted).toEqual([]);
    expect(target.scripts).toHaveLength(0);
  });

  it('keeps the original configuration claim even after all its script nodes are removed', () => {
    const target = freshDocument();
    mountSiteConnections({ enabled: true, crisp: all.crisp }, { document: target });
    for (const script of Array.from(target.scripts)) script.remove();
    const result = mountSiteConnections({ enabled: true, crisp: { enabled: true, websiteId: '66666666-7777-4888-8999-000000000000' } }, { document: target });
    expect(result.mounted).toEqual([]);
    expect(result.issues).toEqual([{ provider: 'crisp', message: expect.stringContaining('reload') }]);
    expect(target.scripts).toHaveLength(0);
  });

  it('does not retry after a synchronous DOM insertion failure', () => {
    const target = freshDocument();
    const append = vi.spyOn(target.head, 'appendChild').mockImplementationOnce(() => { throw new Error('Synthetic insertion failure'); });
    const config = { enabled: true, promoteKit: all.promoteKit };
    expect(() => mountSiteConnections(config, { document: target })).toThrow('Synthetic insertion failure');
    expect(mountSiteConnections(config, { document: target }).mounted).toEqual([]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(target.scripts).toHaveLength(0);
  });
});
