import { configureAnalytics, defineEventCatalog, flushEvents } from './analytics';

describe('product event catalog', () => {
  it('sends listed events and lets a receiver recognise them', () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
    configureAnalytics({ enabled: true, batchSize: 10, flushInterval: 0, getSessionId: () => 's' });
    const events = defineEventCatalog(['draft_opened', 'draft_exported'] as const);
    events.track('draft_exported', { format: 'docx' });
    // @ts-expect-error unlisted names do not type-check
    events.track('draft_exportd');
    flushEvents();
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(sent.map((event: { eventName: string }) => event.eventName)).toEqual(['draft_exported', 'draft_exportd']);
    expect(events.has('draft_opened')).toBe(true);
    expect(events.has('page_view')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects a catalog that lists a name twice', () => {
    expect(() => defineEventCatalog(['a', 'a'])).toThrow();
  });
});
